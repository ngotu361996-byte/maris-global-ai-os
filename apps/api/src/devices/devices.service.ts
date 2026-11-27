import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  HEARTBEAT_INTERVAL_SEC,
  metricAlerts,
  metricWarnings,
  OFFLINE_AFTER_SEC,
  PAIRING_PREFIX,
  PAIRING_TTL_MIN,
  WORKER_JOB_KINDS,
  type CreateDevice,
  type DeviceEventResponse,
  type DeviceMetricResponse,
  type DevicePairingResponse,
  type DeviceResponse,
  type Heartbeat,
  type HeartbeatResponse,
  type PairDevice,
  type PairDeviceResponse,
  type ServerStatusResponse,
  type UpdateDevice,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { DbService, type Tx } from '../db/db.service';

const { devices, deviceMetrics, deviceEvents, workerJobs } = schema;
export type DeviceRow = typeof devices.$inferSelect;
type MetricRow = typeof deviceMetrics.$inferSelect;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
/** Samples kept per device. */
const METRIC_RETENTION_HOURS = 24;

function sameHash(stored: string | null, given: string): boolean {
  if (!stored) return false;
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(sha256(given), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `<prefix>.<tenantId>.<deviceId>.<secret>`, used both for pairing strings and device keys. */
function splitCredential(
  value: string | undefined,
  prefix: string | null,
): { tenantId: string; deviceId: string; secret: string } | null {
  const parts = (value ?? '').trim().split('.');
  if (prefix) {
    if (parts.length !== 4 || parts[0] !== prefix) return null;
    parts.shift();
  } else if (parts.length !== 3) return null;
  const [tenantId, deviceId, secret] = parts as [string, string, string];
  if (!UUID.test(tenantId) || !UUID.test(deviceId) || !SECRET.test(secret)) return null;
  return { tenantId, deviceId, secret };
}

const unauthorized = () =>
  new UnauthorizedException({
    code: 'DEVICE_AUTH_INVALID',
    message: 'Khóa thiết bị không hợp lệ hoặc đã bị thu hồi',
  });

/**
 * Devices and workers (spec Part 26). An administrator creates a device and gets a pairing string
 * that works once, for PAIRING_TTL_MIN minutes. The worker on that machine trades it for a device
 * key and from then on sends a heartbeat with its resource use. Only hashes of the pairing string
 * and the key are stored. Workers always connect out; the server sends back only the device's
 * status, never a command to run.
 */
@Injectable()
export class DevicesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  list(ctx: Ctx): Promise<DeviceResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.tenantId, ctx.tenantId), isNull(devices.deletedAt)))
        .orderBy(asc(devices.name));
      const running = await this.runningCounts(
        tx,
        rows.map((r) => r.id),
      );
      return Promise.all(
        rows.map(async (r) => respond(r, await this.latest(tx, r.id), running.get(r.id) ?? 0)),
      );
    });
  }

  get(ctx: Ctx, id: string): Promise<DeviceResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const r = await this.row(tx, ctx.tenantId, id);
      return respond(r, await this.latest(tx, r.id), await this.runningCount(tx, r.id));
    });
  }

  metrics(ctx: Ctx, id: string, minutes: number): Promise<DeviceMetricResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.row(tx, ctx.tenantId, id);
      const since = new Date(Date.now() - minutes * 60_000);
      const rows = await tx
        .select()
        .from(deviceMetrics)
        .where(and(eq(deviceMetrics.deviceId, id), gte(deviceMetrics.recordedAt, since)))
        .orderBy(asc(deviceMetrics.recordedAt))
        .limit(2000);
      return rows.map(metricResponse);
    });
  }

  events(ctx: Ctx, id: string): Promise<DeviceEventResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.row(tx, ctx.tenantId, id);
      const rows = await tx
        .select()
        .from(deviceEvents)
        .where(eq(deviceEvents.deviceId, id))
        .orderBy(desc(deviceEvents.createdAt))
        .limit(100);
      return rows.map((e) => ({
        id: e.id,
        level: e.level,
        kind: e.kind,
        message: e.message,
        createdAt: e.createdAt.toISOString(),
      }));
    });
  }

  create(ctx: Ctx, body: CreateDevice): Promise<DevicePairingResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const secret = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MIN * 60_000);
      const id = uuidv7();
      const [row] = await tx
        .insert(devices)
        .values({
          id,
          tenantId: ctx.tenantId,
          name: body.name,
          kind: body.kind,
          status: 'pending',
          pairingHash: sha256(secret),
          pairingExpiresAt: expiresAt,
          createdBy: ctx.userId,
        })
        .returning();
      await this.event(tx, row!, 'info', 'created', 'Đã tạo thiết bị, chờ Worker ghép nối');
      await this.log(tx, ctx, 'infra.device.created', id, { name: body.name, kind: body.kind });
      return {
        device: respond(row!, null, 0),
        pairing: `${PAIRING_PREFIX}.${ctx.tenantId}.${id}.${secret}`,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  /** A new pairing string, to move the worker to another machine or after the old one expired. */
  newPairing(ctx: Ctx, id: string): Promise<DevicePairingResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      if (current.status === 'revoked')
        throw new BadRequestException({
          code: 'DEVICE_REVOKED',
          message: 'Thiết bị đã bị thu hồi; tạo thiết bị mới',
        });
      const secret = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MIN * 60_000);
      const [row] = await tx
        .update(devices)
        .set({ pairingHash: sha256(secret), pairingExpiresAt: expiresAt, updatedAt: new Date() })
        .where(eq(devices.id, id))
        .returning();
      await this.log(tx, ctx, 'infra.device.pairing_created', id, { name: current.name });
      return {
        device: respond(row!, await this.latest(tx, id), await this.runningCount(tx, id)),
        pairing: `${PAIRING_PREFIX}.${ctx.tenantId}.${id}.${secret}`,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  update(ctx: Ctx, id: string, body: UpdateDevice): Promise<DeviceResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      const [row] = await tx
        .update(devices)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.maxJobs !== undefined ? { maxJobs: body.maxJobs } : {}),
          updatedAt: new Date(),
        })
        .where(eq(devices.id, id))
        .returning();
      if (body.name !== undefined && body.name !== current.name)
        await this.log(tx, ctx, 'infra.device.renamed', id, { from: current.name, to: body.name });
      if (body.maxJobs !== undefined && body.maxJobs !== current.maxJobs)
        await this.log(tx, ctx, 'infra.device.limit_changed', id, {
          name: current.name,
          from: current.maxJobs,
          to: body.maxJobs,
        });
      return respond(row!, await this.latest(tx, id), await this.runningCount(tx, id));
    });
  }

  /** Paused devices keep reporting but get no work (work arrives in Sprint 14). */
  setPaused(ctx: Ctx, id: string, paused: boolean): Promise<DeviceResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      const from = paused ? 'active' : 'paused';
      if (current.status !== from)
        throw new BadRequestException({
          code: 'DEVICE_STATE',
          message: paused
            ? 'Chỉ tạm dừng được thiết bị đang hoạt động'
            : 'Chỉ chạy lại được thiết bị đang tạm dừng',
        });
      const [row] = await tx
        .update(devices)
        .set({ status: paused ? 'paused' : 'active', updatedAt: new Date() })
        .where(eq(devices.id, id))
        .returning();
      await this.event(
        tx,
        row!,
        'info',
        paused ? 'paused' : 'resumed',
        paused ? 'Đã tạm dừng' : 'Đã chạy lại',
      );
      await this.log(tx, ctx, paused ? 'infra.device.paused' : 'infra.device.resumed', id, {
        name: current.name,
      });
      return respond(row!, await this.latest(tx, id), await this.runningCount(tx, id));
    });
  }

  /** The key stops working at once. A revoked device cannot be paired again. */
  revoke(ctx: Ctx, id: string): Promise<DeviceResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      const [row] = await tx
        .update(devices)
        .set({
          status: 'revoked',
          tokenHash: null,
          pairingHash: null,
          pairingExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(devices.id, id))
        .returning();
      await this.event(tx, row!, 'warning', 'revoked', 'Đã thu hồi khóa thiết bị');
      await requeueJobsOf(tx, row!, 'Thiết bị bị thu hồi');
      await this.log(tx, ctx, 'infra.device.revoked', id, { name: current.name });
      return respond(row!, await this.latest(tx, id), await this.runningCount(tx, id));
    });
  }

  remove(ctx: Ctx, id: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      await tx
        .update(devices)
        .set({
          deletedAt: new Date(),
          status: 'revoked',
          tokenHash: null,
          pairingHash: null,
          pairingExpiresAt: null,
        })
        .where(eq(devices.id, id));
      await requeueJobsOf(tx, current, 'Thiết bị bị xóa');
      await this.log(tx, ctx, 'infra.device.deleted', id, { name: current.name });
    });
  }

  /** The server MARIS runs on, measured here. */
  async server(): Promise<ServerStatusResponse> {
    const cpuPct = await sampleCpu(250);
    let diskUsedGb: number | null = null;
    let diskTotalGb: number | null = null;
    try {
      const s = await statfs(process.cwd());
      diskTotalGb = round((s.blocks * s.bsize) / 1024 ** 3);
      diskUsedGb = round(((s.blocks - s.bfree) * s.bsize) / 1024 ** 3);
    } catch {
      /* not supported here */
    }
    return {
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      uptimeSec: Math.round(os.uptime()),
      cpuCores: os.cpus().length,
      cpuPct,
      ramUsedMb: Math.round((os.totalmem() - os.freemem()) / 1024 ** 2),
      ramTotalMb: Math.round(os.totalmem() / 1024 ** 2),
      diskUsedGb,
      diskTotalGb,
      loadAvg: os.loadavg().map(round),
    };
  }

  // ---------------------------------------------------------------- worker side (no session)

  /** The worker trades a pairing string for a device key. The string works once. */
  async pair(body: PairDevice, ip: string | null): Promise<PairDeviceResponse> {
    const cred = splitCredential(body.pairing, PAIRING_PREFIX);
    const invalid = () =>
      new UnauthorizedException({
        code: 'DEVICE_PAIRING_INVALID',
        message:
          'Chuỗi ghép nối không đúng, đã dùng hoặc đã hết hạn. Tạo chuỗi mới trên trang Hạ tầng.',
      });
    if (!cred) throw invalid();
    return this.db.withContext({ tenantId: cred.tenantId }, async (tx) => {
      const [row] = await tx
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.id, cred.deviceId),
            eq(devices.tenantId, cred.tenantId),
            isNull(devices.deletedAt),
          ),
        );
      if (
        !row ||
        row.status === 'revoked' ||
        !sameHash(row.pairingHash, cred.secret) ||
        !row.pairingExpiresAt ||
        row.pairingExpiresAt.getTime() < Date.now()
      )
        throw invalid();
      const key = randomBytes(32).toString('base64url');
      const now = new Date();
      const [updated] = await tx
        .update(devices)
        .set({
          tokenHash: sha256(key),
          pairingHash: null,
          pairingExpiresAt: null,
          status: row.status === 'pending' ? 'active' : row.status,
          info: body.info,
          pairedAt: now,
          lastSeenAt: now,
          lastIp: ip,
          updatedAt: now,
        })
        .where(eq(devices.id, row.id))
        .returning();
      const host = body.info.hostname ? ` từ máy ${body.info.hostname}` : '';
      await this.event(tx, updated!, 'info', 'paired', `Worker đã ghép nối${host}`);
      await this.audit.append(tx, {
        tenantId: cred.tenantId,
        actorUserId: null,
        action: 'infra.device.paired',
        targetType: 'device',
        targetId: row.id,
        metadata: {
          name: row.name,
          hostname: body.info.hostname ?? null,
          os: body.info.os ?? null,
        },
        ip,
      });
      return {
        deviceId: row.id,
        tenantId: cred.tenantId,
        token: `${cred.tenantId}.${row.id}.${key}`,
        name: row.name,
        heartbeatSec: HEARTBEAT_INTERVAL_SEC,
      };
    });
  }

  /** One report from a worker: its resource use. The answer is the device's status. */
  async heartbeat(
    deviceKey: string | undefined,
    body: Heartbeat,
    ip: string | null,
  ): Promise<HeartbeatResponse> {
    return this.withDevice(deviceKey, async (tx, row) => {
      const now = new Date();
      const previous = await this.latest(tx, row.id);
      const sample = {
        cpuPct: body.cpuPct ?? null,
        ramUsedMb:
          body.ramUsedMb === null || body.ramUsedMb === undefined
            ? null
            : Math.round(body.ramUsedMb),
        ramTotalMb:
          body.ramTotalMb === null || body.ramTotalMb === undefined
            ? null
            : Math.round(body.ramTotalMb),
        diskUsedGb: body.diskUsedGb ?? null,
        diskTotalGb: body.diskTotalGb ?? null,
        gpus: body.gpus ?? [],
        cpuTempC: body.cpuTempC ?? null,
      };
      await tx.insert(deviceMetrics).values({
        id: uuidv7(),
        tenantId: row.tenantId,
        deviceId: row.id,
        ...sample,
        recordedAt: now,
      });
      if (row.lastSeenAt && now.getTime() - row.lastSeenAt.getTime() > OFFLINE_AFTER_SEC * 1000) {
        const minutes = Math.max(
          1,
          Math.round((now.getTime() - row.lastSeenAt.getTime()) / 60_000),
        );
        await this.event(
          tx,
          row,
          'warning',
          'reconnected',
          `Kết nối lại sau ${minutes} phút mất tín hiệu`,
        );
      }
      const before = new Set(
        previous ? metricAlerts(metricResponse(previous)).map((a) => a.key) : [],
      );
      for (const a of metricAlerts(sample))
        if (!before.has(a.key)) await this.event(tx, row, 'warning', 'resource', a.message);
      await tx
        .update(devices)
        .set({
          lastSeenAt: now,
          lastIp: ip,
          ...(body.capabilities
            ? {
                capabilities: body.capabilities.filter((c) =>
                  (WORKER_JOB_KINDS as readonly string[]).includes(c),
                ),
              }
            : {}),
          ...(body.agentVersion && body.agentVersion !== row.info.agentVersion
            ? { info: { ...row.info, agentVersion: body.agentVersion } }
            : {}),
        })
        .where(eq(devices.id, row.id));
      await tx
        .delete(deviceMetrics)
        .where(
          and(
            eq(deviceMetrics.deviceId, row.id),
            lt(
              deviceMetrics.recordedAt,
              new Date(now.getTime() - METRIC_RETENTION_HOURS * 3600_000),
            ),
          ),
        );
      return {
        status: row.status,
        heartbeatSec: HEARTBEAT_INTERVAL_SEC,
        serverTime: now.toISOString(),
      };
    });
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Runs fn as the device that owns this key, inside its tenant. Throws 401 when the key is wrong,
   * the device was deleted or revoked.
   */
  withDevice<T>(
    deviceKey: string | undefined,
    fn: (tx: Tx, device: DeviceRow) => Promise<T>,
  ): Promise<T> {
    const cred = splitCredential(deviceKey, null);
    if (!cred) throw unauthorized();
    return this.db.withContext({ tenantId: cred.tenantId }, async (tx) => {
      const [row] = await tx
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.id, cred.deviceId),
            eq(devices.tenantId, cred.tenantId),
            isNull(devices.deletedAt),
          ),
        );
      if (!row || row.status === 'revoked' || !sameHash(row.tokenHash, cred.secret))
        throw unauthorized();
      return fn(tx, row);
    });
  }

  private async runningCount(tx: Tx, deviceId: string): Promise<number> {
    return (await this.runningCounts(tx, [deviceId])).get(deviceId) ?? 0;
  }

  private async runningCounts(tx: Tx, ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({ deviceId: workerJobs.deviceId, n: count() })
      .from(workerJobs)
      .where(and(eq(workerJobs.status, 'running'), inArray(workerJobs.deviceId, ids)))
      .groupBy(workerJobs.deviceId);
    return new Map(rows.map((r) => [r.deviceId!, Number(r.n)]));
  }

  private async latest(tx: Tx, deviceId: string): Promise<MetricRow | null> {
    const [m] = await tx
      .select()
      .from(deviceMetrics)
      .where(eq(deviceMetrics.deviceId, deviceId))
      .orderBy(desc(deviceMetrics.recordedAt))
      .limit(1);
    return m ?? null;
  }

  private async row(tx: Tx, tenantId: string, id: string): Promise<DeviceRow> {
    const [row] = await tx
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.tenantId, tenantId), isNull(devices.deletedAt)));
    if (!row)
      throw new NotFoundException({ code: 'DEVICE_NOT_FOUND', message: 'Không tìm thấy thiết bị' });
    return row;
  }

  private async event(
    tx: Tx,
    d: DeviceRow,
    level: 'info' | 'warning' | 'error',
    kind: string,
    message: string,
  ): Promise<void> {
    await tx.insert(deviceEvents).values({
      id: uuidv7(),
      tenantId: d.tenantId,
      deviceId: d.id,
      level,
      kind,
      message: message.slice(0, 500),
    });
  }

  private log(tx: Tx, ctx: Ctx, action: string, id: string, metadata?: Record<string, unknown>) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'device',
      targetId: id,
      metadata,
      ip: ctx.ip,
    });
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function metricResponse(m: MetricRow): DeviceMetricResponse {
  return {
    cpuPct: m.cpuPct,
    ramUsedMb: m.ramUsedMb,
    ramTotalMb: m.ramTotalMb,
    diskUsedGb: m.diskUsedGb,
    diskTotalGb: m.diskTotalGb,
    gpus: m.gpus,
    cpuTempC: m.cpuTempC,
    recordedAt: m.recordedAt.toISOString(),
  };
}

function respond(r: DeviceRow, latest: MetricRow | null, runningJobs: number): DeviceResponse {
  const online =
    r.status !== 'revoked' &&
    !!r.lastSeenAt &&
    Date.now() - r.lastSeenAt.getTime() <= OFFLINE_AFTER_SEC * 1000;
  const m = latest ? metricResponse(latest) : null;
  const warnings = online && m ? metricWarnings(m) : [];
  if (r.status === 'active' && r.lastSeenAt && !online) warnings.unshift('Mất kết nối');
  const pairingOpen =
    !!r.pairingHash && !!r.pairingExpiresAt && r.pairingExpiresAt.getTime() > Date.now();
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    online,
    info: r.info,
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    lastIp: r.lastIp,
    pairedAt: r.pairedAt?.toISOString() ?? null,
    pairingExpiresAt: pairingOpen ? r.pairingExpiresAt!.toISOString() : null,
    latest: m,
    maxJobs: r.maxJobs,
    capabilities: r.capabilities,
    runningJobs,
    warnings,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Busy share of all CPUs over a short window, in percent. */
async function sampleCpu(ms: number): Promise<number | null> {
  const snap = () =>
    os.cpus().reduce(
      (acc, c) => {
        const t = c.times;
        acc.idle += t.idle;
        acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
        return acc;
      },
      { idle: 0, total: 0 },
    );
  const a = snap();
  await new Promise((r) => setTimeout(r, ms));
  const b = snap();
  const total = b.total - a.total;
  if (total <= 0) return null;
  return round(((total - (b.idle - a.idle)) / total) * 100);
}

/** Puts the jobs a device was running back in the queue, for another worker. */
export async function requeueJobsOf(tx: Tx, d: DeviceRow, why: string): Promise<number> {
  const moved = await tx
    .update(workerJobs)
    .set({
      status: 'queued',
      deviceId: null,
      leaseExpiresAt: null,
      progress: 0,
      progressNote: null,
      excludedDeviceIds: sql`array_append(${workerJobs.excludedDeviceIds}, ${d.id}::uuid)`,
      updatedAt: new Date(),
    })
    .where(and(eq(workerJobs.deviceId, d.id), eq(workerJobs.status, 'running')))
    .returning({ id: workerJobs.id });
  for (const j of moved)
    await tx.insert(schema.workerJobLogs).values({
      id: uuidv7(),
      tenantId: d.tenantId,
      jobId: j.id,
      deviceId: d.id,
      level: 'warning',
      message: `${why} (${d.name}), chuyển việc về hàng đợi cho Worker khác`,
    });
  return moved.length;
}
