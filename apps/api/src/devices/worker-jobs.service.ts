import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  CODE_RUNNER_KINDS,
  isInternalJobKind,
  JOB_LEASE_SEC,
  JOB_POLL_SEC,
  JOB_RESULT_MAX_BYTES,
  metricAlerts,
  SANDBOX_LIMITS,
  WORKER_JOB_KIND_INFO,
  workerJobInputSchemas,
  type ClaimJobResponse,
  type CreateWorkerJob,
  type FinishJob,
  type JobProgress,
  type JobProgressResponse,
  type WorkerJobKind,
  type WorkerJobLogResponse,
  type WorkerJobResponse,
  type WorkerJobStatus,
} from '@maris/contracts';
import { createWorkerJobSchema, finishJobSchema, jobProgressSchema } from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { DbService, type Tx } from '../db/db.service';
import { DevicesService, type DeviceRow } from './devices.service';

const { devices, deviceMetrics, deviceEvents, workerJobs, workerJobLogs } = schema;
export type JobRow = typeof workerJobs.$inferSelect;
type LogLevel = 'info' | 'warning' | 'error';

/** A device that lost a job may take it back after it has waited this long for another worker. */
const EXCLUDE_SEC = 60;

export interface JobCreateOptions {
  /** May this person queue code.run jobs (the infra.code permission)? */
  canRunCode: boolean;
  /** Queued by MARIS itself after its own checks (e.g. image jobs from the content library). */
  internal?: boolean;
}

/** A job a device is running now, as seen by that device. */
export type RunningJob = { job: JobRow; device: DeviceRow };

const isCodeRunner = (kind: string) => (CODE_RUNNER_KINDS as readonly string[]).includes(kind);

const badState = (message: string) => new BadRequestException({ code: 'JOB_STATE', message });
const notYours = () =>
  new ForbiddenException({
    code: 'JOB_NOT_RUNNING_HERE',
    message: 'Việc này không còn chạy trên máy này (đã xong, bị hủy hoặc chuyển sang máy khác)',
  });

/**
 * Jobs for workers (spec Part 26). People queue jobs; workers ask for one when they have room
 * (their max_jobs limit, no RAM or disk alert, a cool GPU for GPU jobs), hold a lease while they
 * report progress, and finish it. A lease that runs out, a revoked device or a manual move puts
 * the job back in the queue for another worker, up to max_attempts. Clean-up of expired leases and
 * timeouts happens whenever a worker asks for work or someone opens the list, so there is no
 * background process to keep alive.
 */
@Injectable()
export class WorkerJobsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly devices: DevicesService,
  ) {}

  list(
    ctx: Ctx,
    filter: { status?: WorkerJobStatus; deviceId?: string; limit: number },
  ): Promise<WorkerJobResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await sweep(tx, ctx.tenantId);
      const where: SQL[] = [eq(workerJobs.tenantId, ctx.tenantId)];
      if (filter.status) where.push(eq(workerJobs.status, filter.status));
      if (filter.deviceId) where.push(eq(workerJobs.deviceId, filter.deviceId));
      const rows = await tx
        .select()
        .from(workerJobs)
        .where(and(...where))
        .orderBy(desc(workerJobs.createdAt))
        .limit(filter.limit);
      const names = await deviceNames(
        tx,
        rows.map((r) => r.deviceId),
      );
      return rows.map((r) => respond(r, names));
    });
  }

  get(ctx: Ctx, id: string): Promise<WorkerJobResponse & { logs: WorkerJobLogResponse[] }> {
    return this.db.withContext(ctx, async (tx) => {
      await sweep(tx, ctx.tenantId);
      const job = await this.row(tx, ctx.tenantId, id);
      const logs = await tx
        .select()
        .from(workerJobLogs)
        .where(eq(workerJobLogs.jobId, id))
        .orderBy(asc(workerJobLogs.createdAt))
        .limit(500);
      return {
        ...respond(job, await deviceNames(tx, [job.deviceId])),
        logs: logs.map((l) => ({
          id: l.id,
          level: l.level,
          message: l.message,
          deviceId: l.deviceId,
          createdAt: l.createdAt.toISOString(),
        })),
      };
    });
  }

  create(ctx: Ctx, raw: CreateWorkerJob, opts: JobCreateOptions): Promise<WorkerJobResponse> {
    return this.db.withContext(ctx, (tx) => this.createIn(tx, ctx, raw, opts));
  }

  /** Queues a job inside the caller's transaction. */
  async createIn(
    tx: Tx,
    ctx: Ctx,
    raw: CreateWorkerJob,
    opts: JobCreateOptions,
  ): Promise<WorkerJobResponse> {
    const body = createWorkerJobSchema.parse(raw);
    if (isInternalJobKind(body.kind) && !opts.internal)
      throw new BadRequestException({
        code: 'JOB_KIND_INTERNAL',
        message: `Việc “${WORKER_JOB_KIND_INFO[body.kind].label}” chỉ tạo được từ màn hình của nó (ví dụ xử lý ảnh từ kho nội dung), vì ở đó MARIS kiểm tra quyền sử dụng tệp`,
      });
    const parsed = workerJobInputSchemas[body.kind].safeParse(body.input);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'JOB_INPUT_INVALID',
        message: `Ô nhập không hợp lệ: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`,
      });
    const isCode = body.kind === 'code.run';
    let codeMeta: Record<string, unknown> = {};
    if (isCode) {
      if (!opts.canRunCode)
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Thiếu quyền infra.code',
        });
      if (body.timeoutSec !== undefined && body.timeoutSec > SANDBOX_LIMITS.maxTimeoutSec)
        throw new BadRequestException({
          code: 'JOB_INPUT_INVALID',
          message: `Chạy mã tối đa ${SANDBOX_LIMITS.maxTimeoutSec} giây`,
        });
      // Code runs only on Code Runner machines, whatever the request asked for.
      body.targetKinds = [...CODE_RUNNER_KINDS];
      const input = parsed.data as { language: string; code: string };
      codeMeta = {
        language: input.language,
        codeSha256: createHash('sha256').update(input.code).digest('hex'),
        codeChars: input.code.length,
      };
    }
    {
      if (body.targetDeviceId) {
        const [d] = await tx
          .select()
          .from(devices)
          .where(
            and(
              eq(devices.id, body.targetDeviceId),
              eq(devices.tenantId, ctx.tenantId),
              isNull(devices.deletedAt),
            ),
          );
        if (!d || d.status === 'revoked')
          throw new BadRequestException({
            code: 'DEVICE_NOT_FOUND',
            message: 'Không có thiết bị đó, hoặc thiết bị đã bị thu hồi',
          });
        if (isCode && !isCodeRunner(d.kind))
          throw new BadRequestException({
            code: 'DEVICE_NOT_CODE_RUNNER',
            message: 'Chỉ chạy mã trên thiết bị loại Code Runner',
          });
      }
      const info = WORKER_JOB_KIND_INFO[body.kind];
      const id = uuidv7();
      const [row] = await tx
        .insert(workerJobs)
        .values({
          id,
          tenantId: ctx.tenantId,
          kind: body.kind,
          title: body.title ?? info.label,
          input: parsed.data as Record<string, unknown>,
          priority: body.priority,
          targetDeviceId: body.targetDeviceId,
          targetKinds: body.targetKinds,
          needGpu: body.needGpu,
          minFreeRamMb: body.minFreeRamMb,
          timeoutSec: body.timeoutSec ?? info.timeoutSec,
          maxAttempts: body.maxAttempts,
          createdBy: ctx.userId,
        })
        .returning();
      await log(tx, row!, null, 'info', 'Đã giao việc, chờ Worker nhận');
      await this.log(tx, ctx, 'infra.job.created', id, {
        kind: body.kind,
        title: row!.title,
        ...codeMeta,
      });
      return respond(row!, new Map());
    }
  }

  /** A waiting job stops at once; a running one is told to stop at its next report. */
  cancel(ctx: Ctx, id: string): Promise<WorkerJobResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const job = await this.row(tx, ctx.tenantId, id);
      const now = new Date();
      let row: JobRow;
      if (job.status === 'queued') {
        [row] = (await tx
          .update(workerJobs)
          .set({ status: 'cancelled', cancelRequested: true, finishedAt: now, updatedAt: now })
          .where(eq(workerJobs.id, id))
          .returning()) as [JobRow];
        await log(tx, row, null, 'warning', 'Đã hủy trước khi chạy');
      } else if (job.status === 'running') {
        [row] = (await tx
          .update(workerJobs)
          .set({ cancelRequested: true, updatedAt: now })
          .where(eq(workerJobs.id, id))
          .returning()) as [JobRow];
        await log(
          tx,
          row,
          null,
          'warning',
          'Yêu cầu hủy; Worker sẽ dừng ở lần báo tiến độ kế tiếp',
        );
      } else throw badState('Việc đã kết thúc, không hủy được');
      await this.log(tx, ctx, 'infra.job.cancelled', id, { title: job.title });
      return respond(row, await deviceNames(tx, [row.deviceId]));
    });
  }

  /** Takes a running job off its worker and puts it back in the queue for another one. */
  reassign(ctx: Ctx, id: string): Promise<WorkerJobResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const job = await this.row(tx, ctx.tenantId, id);
      if (job.status !== 'running' || !job.deviceId)
        throw badState('Chỉ chuyển được việc đang chạy');
      const names = await deviceNames(tx, [job.deviceId]);
      const row = await requeue(tx, job);
      await log(
        tx,
        row,
        job.deviceId,
        'warning',
        `Người quản trị chuyển việc khỏi ${names.get(job.deviceId) ?? 'Worker'}, chờ Worker khác`,
      );
      await this.log(tx, ctx, 'infra.job.reassigned', id, {
        title: job.title,
        fromDevice: job.deviceId,
      });
      return respond(row, new Map());
    });
  }

  /** Queues a copy of a finished job. */
  retry(ctx: Ctx, id: string, opts: JobCreateOptions): Promise<WorkerJobResponse> {
    return this.db
      .withContext(ctx, async (tx) => this.row(tx, ctx.tenantId, id))
      .then((job) => {
        if (job.status === 'queued' || job.status === 'running')
          throw badState('Việc chưa kết thúc');
        return this.create(
          ctx,
          {
            kind: job.kind as WorkerJobKind,
            title: job.title,
            input: job.input,
            priority: job.priority,
            targetDeviceId: job.targetDeviceId,
            targetKinds: job.targetKinds,
            needGpu: job.needGpu,
            minFreeRamMb: job.minFreeRamMb,
            timeoutSec: job.timeoutSec,
            maxAttempts: job.maxAttempts,
          },
          opts,
        );
      });
  }

  // ---------------------------------------------------------------- worker side (device key)

  /** The worker asks for one job. It gets none while paused, full, or short of resources. */
  claim(deviceKey: string | undefined): Promise<ClaimJobResponse> {
    const none: ClaimJobResponse = { job: null, pollSec: JOB_POLL_SEC };
    return this.devices.withDevice(deviceKey, async (tx, d) => {
      await sweep(tx, d.tenantId);
      const kinds = isCodeRunner(d.kind)
        ? d.capabilities
        : d.capabilities.filter((c) => c !== 'code.run');
      if (d.status !== 'active' || d.maxJobs === 0 || kinds.length === 0) return none;
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(workerJobs)
        .where(and(eq(workerJobs.deviceId, d.id), eq(workerJobs.status, 'running')))) as [
        { n: number },
      ];
      if (n >= d.maxJobs) return none;

      const [m] = await tx
        .select()
        .from(deviceMetrics)
        .where(eq(deviceMetrics.deviceId, d.id))
        .orderBy(desc(deviceMetrics.recordedAt))
        .limit(1);
      const alerts = m ? metricAlerts(m).map((a) => a.key) : [];
      // Resource limits: no new work while RAM or disk is nearly full.
      if (alerts.includes('ram') || alerts.includes('disk')) return none;
      const gpuOk = !!m && m.gpus.length > 0 && !alerts.some((a) => a.startsWith('gpu:'));
      const freeRam =
        m && m.ramTotalMb !== null && m.ramUsedMb !== null ? m.ramTotalMb - m.ramUsedMb : 0;

      const excludeUntil = new Date(Date.now() - EXCLUDE_SEC * 1000);
      const [job] = await tx
        .select()
        .from(workerJobs)
        .where(
          and(
            eq(workerJobs.tenantId, d.tenantId),
            eq(workerJobs.status, 'queued'),
            // Only a Code Runner device gets code, even if its worker says it can run it.
            inArray(workerJobs.kind, kinds),
            sql`(${workerJobs.targetDeviceId} IS NULL OR ${workerJobs.targetDeviceId} = ${d.id})`,
            sql`(cardinality(${workerJobs.targetKinds}) = 0 OR ${d.kind} = ANY(${workerJobs.targetKinds}))`,
            gpuOk ? sql`true` : eq(workerJobs.needGpu, false),
            sql`${workerJobs.minFreeRamMb} <= ${freeRam}`,
            sql`(NOT (${d.id}::uuid = ANY(${workerJobs.excludedDeviceIds}))
                 OR ${workerJobs.targetDeviceId} = ${d.id}
                 OR ${workerJobs.updatedAt} < ${excludeUntil.toISOString()}::timestamptz)`,
          ),
        )
        .orderBy(desc(workerJobs.priority), asc(workerJobs.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return none;
      const now = new Date();
      const [row] = await tx
        .update(workerJobs)
        .set({
          status: 'running',
          deviceId: d.id,
          attempts: job.attempts + 1,
          leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_SEC * 1000),
          startedAt: now,
          progress: 0,
          progressNote: null,
          updatedAt: now,
        })
        .where(eq(workerJobs.id, job.id))
        .returning();
      await log(
        tx,
        row!,
        d.id,
        'info',
        `${d.name} nhận việc (lần ${row!.attempts}/${row!.maxAttempts})`,
      );
      return {
        job: {
          id: row!.id,
          kind: row!.kind as WorkerJobKind,
          input: row!.input,
          timeoutSec: row!.timeoutSec,
          leaseSec: JOB_LEASE_SEC,
        },
        pollSec: JOB_POLL_SEC,
      };
    });
  }

  /** Progress from the worker. The answer tells it to stop when the job is no longer its to run. */
  progress(
    deviceKey: string | undefined,
    id: string,
    raw: JobProgress,
  ): Promise<JobProgressResponse> {
    const body = jobProgressSchema.parse(raw);
    return this.devices.withDevice(deviceKey, async (tx, d) => {
      await sweep(tx, d.tenantId);
      const job = await this.mine(tx, d, id);
      const stop: JobProgressResponse = { cancel: true, leaseSec: JOB_LEASE_SEC };
      if (!job || job.cancelRequested) return stop;
      const now = new Date();
      const [row] = await tx
        .update(workerJobs)
        .set({
          ...(body.progress !== undefined ? { progress: body.progress } : {}),
          ...(body.note !== undefined ? { progressNote: body.note || null } : {}),
          leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_SEC * 1000),
          updatedAt: now,
        })
        .where(eq(workerJobs.id, id))
        .returning();
      for (const l of body.logs) await log(tx, row!, d.id, l.level, l.message);
      return { cancel: false, leaseSec: JOB_LEASE_SEC };
    });
  }

  /** The worker is done with a job. Late or repeated reports for a job it no longer holds are ignored. */
  finish(
    deviceKey: string | undefined,
    id: string,
    raw: FinishJob,
  ): Promise<{ accepted: boolean }> {
    const body = finishJobSchema.parse(raw);
    const resultJson = body.result === undefined ? null : JSON.stringify(body.result);
    if (resultJson !== null && Buffer.byteLength(resultJson) > JOB_RESULT_MAX_BYTES)
      throw new BadRequestException({
        code: 'JOB_RESULT_TOO_LARGE',
        message: `Kết quả vượt ${JOB_RESULT_MAX_BYTES / 1024} KB`,
      });
    return this.devices.withDevice(deviceKey, async (tx, d) => {
      const job = await this.mine(tx, d, id);
      if (!job) return { accepted: false };
      const now = new Date();
      const status: WorkerJobStatus =
        body.status === 'cancelled' && !job.cancelRequested ? 'failed' : body.status;
      const [row] = await tx
        .update(workerJobs)
        .set({
          status,
          progress: status === 'completed' ? 100 : job.progress,
          result: resultJson === null ? null : (JSON.parse(resultJson) as unknown),
          errorCode:
            status === 'completed'
              ? null
              : (body.errorCode ?? (status === 'cancelled' ? 'CANCELLED' : 'JOB_FAILED')),
          errorMessage: status === 'completed' ? null : (body.errorMessage ?? null),
          leaseExpiresAt: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(workerJobs.id, id))
        .returning();
      for (const l of body.logs) await log(tx, row!, d.id, l.level, l.message);
      if (status === 'completed') await log(tx, row!, d.id, 'info', `${d.name} làm xong`);
      else if (status === 'cancelled')
        await log(tx, row!, d.id, 'warning', `${d.name} đã dừng theo yêu cầu hủy`);
      else {
        const why = body.errorMessage ?? body.errorCode ?? 'không rõ lý do';
        await log(tx, row!, d.id, 'error', `${d.name} báo lỗi: ${why}`);
        await deviceEvent(tx, d, 'warning', 'job_failed', `Việc “${row!.title}” lỗi: ${why}`);
      }
      return { accepted: true };
    });
  }

  /**
   * For a worker that fetches or sends files of a job: the job, while this device is running it.
   * Throws when it is not (finished, cancelled, moved to another worker, or never its own).
   */
  runningJob(deviceKey: string | undefined, id: string): Promise<RunningJob> {
    return this.devices.withDevice(deviceKey, async (tx, d) => {
      const job = await this.mine(tx, d, id);
      if (!job || job.cancelRequested) throw notYours();
      return { job, device: d };
    });
  }

  /** Locks the job again inside another transaction, checking it is still this device's. */
  async lockRunningIn(tx: Tx, device: DeviceRow, id: string): Promise<JobRow> {
    const job = await this.mine(tx, device, id);
    if (!job || job.cancelRequested) throw notYours();
    return job;
  }

  /** Jobs of one kind whose input field equals a value, newest first. */
  async findByInput(
    tx: Tx,
    ctx: Ctx,
    kind: WorkerJobKind,
    field: string,
    value: string,
    limit: number,
  ) {
    await sweep(tx, ctx.tenantId);
    const rows = await tx
      .select()
      .from(workerJobs)
      .where(
        and(
          eq(workerJobs.tenantId, ctx.tenantId),
          eq(workerJobs.kind, kind),
          sql`${workerJobs.input} ->> ${field} = ${value}`,
        ),
      )
      .orderBy(desc(workerJobs.createdAt))
      .limit(limit);
    const names = await deviceNames(
      tx,
      rows.map((r) => r.deviceId),
    );
    return rows.map((r) => ({ row: r, response: respond(r, names) }));
  }

  // ---------------------------------------------------------------------------------------------

  /** The job if this device is running it now. */
  private async mine(tx: Tx, d: DeviceRow, id: string): Promise<JobRow | null> {
    const [job] = await tx
      .select()
      .from(workerJobs)
      .where(
        and(
          eq(workerJobs.id, id),
          eq(workerJobs.tenantId, d.tenantId),
          eq(workerJobs.deviceId, d.id),
          eq(workerJobs.status, 'running'),
        ),
      )
      .for('update');
    return job ?? null;
  }

  private async row(tx: Tx, tenantId: string, id: string): Promise<JobRow> {
    const [row] = await tx
      .select()
      .from(workerJobs)
      .where(and(eq(workerJobs.id, id), eq(workerJobs.tenantId, tenantId)));
    if (!row)
      throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Không tìm thấy việc' });
    return row;
  }

  private log(tx: Tx, ctx: Ctx, action: string, id: string, metadata: Record<string, unknown>) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'worker_job',
      targetId: id,
      metadata,
      ip: ctx.ip,
    });
  }
}

/**
 * Leases that ran out go back to the queue (or fail after max_attempts); jobs past their time
 * limit fail and their worker is told to stop.
 */
export async function sweep(tx: Tx, tenantId: string): Promise<void> {
  const now = new Date();
  const lost = await tx
    .select()
    .from(workerJobs)
    .where(
      and(
        eq(workerJobs.tenantId, tenantId),
        eq(workerJobs.status, 'running'),
        lt(workerJobs.leaseExpiresAt, now),
      ),
    )
    .for('update', { skipLocked: true });
  const timedOut = await tx
    .select()
    .from(workerJobs)
    .where(
      and(
        eq(workerJobs.tenantId, tenantId),
        eq(workerJobs.status, 'running'),
        sql`${workerJobs.startedAt} + make_interval(secs => ${workerJobs.timeoutSec}) < ${now.toISOString()}::timestamptz`,
      ),
    )
    .for('update', { skipLocked: true });
  if (lost.length === 0 && timedOut.length === 0) return;
  const names = await deviceNames(
    tx,
    [...lost, ...timedOut].map((j) => j.deviceId),
  );
  const done = new Set<string>();
  for (const job of timedOut) {
    done.add(job.id);
    const [row] = await tx
      .update(workerJobs)
      .set({
        status: 'failed',
        cancelRequested: true,
        errorCode: 'JOB_TIMEOUT',
        errorMessage: `Chạy quá ${job.timeoutSec} giây`,
        leaseExpiresAt: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(workerJobs.id, job.id))
      .returning();
    await log(tx, row!, job.deviceId, 'error', `Quá thời gian ${job.timeoutSec} giây, dừng việc`);
  }
  for (const job of lost) {
    if (done.has(job.id)) continue;
    const name = names.get(job.deviceId ?? '') ?? 'Worker';
    if (job.attempts >= job.maxAttempts) {
      const [row] = await tx
        .update(workerJobs)
        .set({
          status: 'failed',
          errorCode: 'WORKER_LOST',
          errorMessage: `Mất kết nối với Worker sau ${job.attempts} lần thử`,
          leaseExpiresAt: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(workerJobs.id, job.id))
        .returning();
      await log(
        tx,
        row!,
        job.deviceId,
        'error',
        `${name} mất kết nối; đã thử ${job.attempts} lần, dừng`,
      );
    } else {
      const row = await requeue(tx, job);
      await log(
        tx,
        row,
        job.deviceId,
        'warning',
        `${name} mất kết nối, chuyển việc sang Worker khác`,
      );
    }
  }
}

async function requeue(tx: Tx, job: JobRow): Promise<JobRow> {
  const [row] = await tx
    .update(workerJobs)
    .set({
      status: 'queued',
      deviceId: null,
      leaseExpiresAt: null,
      progress: 0,
      progressNote: null,
      excludedDeviceIds: job.deviceId
        ? sql`array_append(${workerJobs.excludedDeviceIds}, ${job.deviceId}::uuid)`
        : workerJobs.excludedDeviceIds,
      updatedAt: new Date(),
    })
    .where(eq(workerJobs.id, job.id))
    .returning();
  return row!;
}

async function log(tx: Tx, job: JobRow, deviceId: string | null, level: LogLevel, message: string) {
  await tx.insert(workerJobLogs).values({
    id: uuidv7(),
    tenantId: job.tenantId,
    jobId: job.id,
    deviceId,
    level,
    message: message.slice(0, 1000),
  });
}

async function deviceEvent(tx: Tx, d: DeviceRow, level: LogLevel, kind: string, message: string) {
  await tx.insert(deviceEvents).values({
    id: uuidv7(),
    tenantId: d.tenantId,
    deviceId: d.id,
    level,
    kind,
    message: message.slice(0, 500),
  });
}

async function deviceNames(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select({ id: devices.id, name: devices.name })
    .from(devices)
    .where(inArray(devices.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function respond(r: JobRow, names: Map<string, string>): WorkerJobResponse {
  return {
    id: r.id,
    kind: r.kind as WorkerJobKind,
    title: r.title,
    input: r.input,
    status: r.status,
    priority: r.priority,
    targetDeviceId: r.targetDeviceId,
    targetKinds: r.targetKinds,
    needGpu: r.needGpu,
    minFreeRamMb: r.minFreeRamMb,
    timeoutSec: r.timeoutSec,
    maxAttempts: r.maxAttempts,
    attempts: r.attempts,
    deviceId: r.deviceId,
    deviceName: r.deviceId ? (names.get(r.deviceId) ?? null) : null,
    progress: r.progress,
    progressNote: r.progressNote,
    result: r.result ?? null,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    cancelRequested: r.cancelRequested,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}
