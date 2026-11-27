import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  createItemSchema,
  IMAGE_PRESET_INFO,
  IMAGE_PRESETS,
  MEDIA_LIMITS,
  OFFLINE_AFTER_SEC,
  processImageSchema,
  workerJobInputSchemas,
  type ImagePreset,
  type MediaJobResponse,
  type MediaJobsResponse,
  type MediaOutputResponse,
  type ProcessImage,
  type WorkerJobResponse,
} from '@maris/contracts';
import type { z } from 'zod';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { DbService, type Tx } from '../db/db.service';
import { WorkerJobsService, type JobRow } from '../devices/worker-jobs.service';
import { ContentService, type AssetRow } from './content.service';

const { contentMediaOutputs, contentItems, devices, users } = schema;
type MediaInput = z.output<(typeof workerJobInputSchemas)['media.image']>;

const KIND = 'media.image';
const bad = (code: string, message: string) => new BadRequestException({ code, message });

/** The person who queued the job, acting through the worker that runs it. */
const jobCtx = (job: JobRow): Ctx => ({ tenantId: job.tenantId, userId: job.createdBy, ip: null });

/**
 * Image processing on a Media Worker (spec Part 13: chuẩn hóa kích thước, thumbnail, logo, tỉ lệ
 * khung hình; Part 26: work runs on workers that call in). MARIS checks the image and logo, then
 * queues a media.image job. The worker that takes it may fetch only that image and logo, and only
 * while it runs the job; each image it sends back becomes a new image item in draft, traced to
 * the image, the logo and the job, so a person approves it before it is used.
 */
@Injectable()
export class ContentMediaService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly content: ContentService,
    private readonly jobs: WorkerJobsService,
  ) {}

  processImage(ctx: Ctx, assetId: string, raw: ProcessImage): Promise<MediaJobResponse> {
    const { targetDeviceId, ...rest } = processImageSchema.parse(raw);
    return this.db.withContext(ctx, async (tx) => {
      const asset = await this.content.assetIn(tx, ctx, assetId);
      usableImage(asset, 'Ảnh gốc');
      if (rest.logoAssetId) {
        if (rest.logoAssetId === assetId) throw bad('MEDIA_LOGO_INVALID', 'Logo phải là ảnh khác');
        usableImage(await this.content.assetIn(tx, ctx, rest.logoAssetId), 'Logo');
      }
      if (rest.folderId) await this.content.folderIn(tx, ctx, rest.folderId, 'output');
      const job = await this.jobs.createIn(
        tx,
        ctx,
        {
          kind: KIND,
          title: `Xử lý ảnh: ${asset.title}`.slice(0, 120),
          input: { assetId, ...rest },
          targetDeviceId,
          maxAttempts: 2,
        },
        { canRunCode: false, internal: true },
      );
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'content.media.requested',
        targetType: 'content_asset',
        targetId: assetId,
        metadata: {
          jobId: job.id,
          presets: rest.presets,
          logoAssetId: rest.logoAssetId,
          format: rest.format,
        },
        ip: ctx.ip,
      });
      return (await this.responses(tx, ctx, [{ row: null, response: job }]))[0]!;
    });
  }

  list(ctx: Ctx, assetId: string): Promise<MediaJobsResponse> {
    return this.db.withContext(ctx, async (tx) => {
      await this.content.assetIn(tx, ctx, assetId);
      const found = await this.jobs.findByInput(tx, ctx, KIND, 'assetId', assetId, 20);
      const workers = await tx
        .select({ id: devices.id, name: devices.name, lastSeenAt: devices.lastSeenAt })
        .from(devices)
        .where(
          and(
            eq(devices.tenantId, ctx.tenantId),
            eq(devices.status, 'active'),
            isNull(devices.deletedAt),
            sql`${KIND} = ANY(${devices.capabilities})`,
          ),
        );
      const now = Date.now();
      return {
        jobs: await this.responses(tx, ctx, found),
        workers: workers.map((w) => ({
          id: w.id,
          name: w.name,
          online: !!w.lastSeenAt && now - w.lastSeenAt.getTime() < OFFLINE_AFTER_SEC * 1000,
        })),
      };
    });
  }

  async cancel(ctx: Ctx, jobId: string): Promise<MediaJobResponse> {
    if ((await this.jobs.get(ctx, jobId)).kind !== KIND) throw notFound();
    const job = await this.jobs.cancel(ctx, jobId);
    return this.db.withContext(
      ctx,
      async (tx) => (await this.responses(tx, ctx, [{ row: null, response: job }]))[0]!,
    );
  }

  // ---------------------------------------------------------------- worker side (device key)

  /** The image or logo of a job, for the worker running it, and nothing else. */
  async agentFile(deviceKey: string | undefined, jobId: string, assetId: string) {
    const { job } = await this.jobs.runningJob(deviceKey, jobId);
    if (job.kind !== KIND) throw notFound();
    const input = job.input as MediaInput;
    if (assetId !== input.assetId && assetId !== input.logoAssetId) throw notFound();
    return this.content.assetFile(jobCtx(job), assetId);
  }

  /**
   * One output image from the worker running the job. It must really be an image; it becomes a
   * new image item with one version. Sending the same size again returns the item made before.
   */
  async agentOutput(
    deviceKey: string | undefined,
    jobId: string,
    preset: ImagePreset,
    rawName: string,
    body: Readable,
  ): Promise<MediaOutputResponse> {
    const { job, device } = await this.jobs.runningJob(deviceKey, jobId);
    if (job.kind !== KIND) throw notFound();
    const input = job.input as MediaInput;
    if (!input.presets.includes(preset))
      throw bad('MEDIA_PRESET_NOT_IN_JOB', 'Việc này không yêu cầu cỡ ảnh đó');
    const ctx = jobCtx(job);
    const before = await this.db.withContext(ctx, (tx) => this.output(tx, jobId, preset));
    if (before) return { itemId: before, duplicate: true };

    const file = await this.content.receiveFile(ctx, rawName, body);
    try {
      if (file.type.kind !== 'image')
        throw new HttpException(
          { code: 'MEDIA_OUTPUT_NOT_IMAGE', message: 'Kết quả gửi lên không phải ảnh' },
          415,
        );
      const out = await this.db.withContext(ctx, async (tx) => {
        await this.jobs.lockRunningIn(tx, device, jobId);
        const again = await this.output(tx, jobId, preset);
        if (again) return { itemId: again, duplicate: true };
        const source = await this.content.assetIn(tx, ctx, input.assetId);
        const info = IMAGE_PRESET_INFO[preset];
        const folderId = input.folderId
          ? await this.content
              .folderIn(tx, ctx, input.folderId, 'output')
              .then((f) => f.id)
              .catch(() => null)
          : null;
        let item = await this.content.createItemIn(
          tx,
          ctx,
          createItemSchema.parse({
            title: `${source.title} · ${info.label}`.slice(0, 200),
            kind: 'image',
            folderId,
            tags: ['media-worker', preset],
          }),
          null,
        );
        item = await this.content.addFileVersionIn(tx, ctx, item, file, {
          sourceAssetIds: [input.assetId, ...(input.logoAssetId ? [input.logoAssetId] : [])],
          workerJobId: jobId,
          note: `Media Worker ${device.name}: ${info.label}${info.width ? ` ${info.width}×${info.height}` : ''}${input.logoAssetId ? ', gắn logo' : ''}`,
        });
        await tx.insert(contentMediaOutputs).values({
          id: uuidv7(),
          tenantId: ctx.tenantId,
          jobId,
          preset,
          itemId: item.id,
        });
        await this.audit.append(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'content.media.output_saved',
          targetType: 'content_item',
          targetId: item.id,
          metadata: {
            jobId,
            deviceId: device.id,
            preset,
            mime: file.type.mime,
            sizeBytes: file.size,
            sha256: file.sha256,
          },
          ip: null,
        });
        await file.staged.commit();
        return { itemId: item.id, duplicate: false };
      });
      if (out.duplicate) await file.staged.discard();
      return out;
    } catch (e) {
      await file.staged.discard();
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------------

  private async output(tx: Tx, jobId: string, preset: string): Promise<string | null> {
    const [o] = await tx
      .select({ itemId: contentMediaOutputs.itemId })
      .from(contentMediaOutputs)
      .where(and(eq(contentMediaOutputs.jobId, jobId), eq(contentMediaOutputs.preset, preset)));
    return o?.itemId ?? null;
  }

  private async responses(
    tx: Tx,
    ctx: Ctx,
    jobs: { row: JobRow | null; response: WorkerJobResponse }[],
  ): Promise<MediaJobResponse[]> {
    if (jobs.length === 0) return [];
    const ids = jobs.map((j) => j.response.id);
    const outputs = await tx
      .select({
        jobId: contentMediaOutputs.jobId,
        preset: contentMediaOutputs.preset,
        itemId: contentItems.id,
        title: contentItems.title,
        status: contentItems.status,
      })
      .from(contentMediaOutputs)
      .innerJoin(contentItems, eq(contentItems.id, contentMediaOutputs.itemId))
      .where(
        and(
          eq(contentMediaOutputs.tenantId, ctx.tenantId),
          inArray(contentMediaOutputs.jobId, ids),
        ),
      );
    const creators = [...new Set(jobs.map((j) => j.row?.createdBy ?? ctx.userId))];
    const people = await tx
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, creators));
    const name = new Map(people.map((p) => [p.id, p.name]));
    const order = (p: string) => IMAGE_PRESETS.indexOf(p as ImagePreset);
    return jobs.map(({ row, response: j }) => {
      const input = j.input as MediaInput;
      return {
        id: j.id,
        title: j.title,
        status: j.status,
        progress: j.progress,
        progressNote: j.progressNote,
        presets: input.presets,
        logoAssetId: input.logoAssetId ?? null,
        deviceName: j.deviceName,
        errorMessage: j.errorMessage,
        cancelRequested: j.cancelRequested,
        createdByName: name.get(row?.createdBy ?? ctx.userId) ?? '',
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
        outputs: outputs
          .filter((o) => o.jobId === j.id)
          .sort((a, b) => order(a.preset) - order(b.preset))
          .map((o) => ({
            preset: o.preset as ImagePreset,
            itemId: o.itemId,
            title: o.title,
            status: o.status,
          })),
      };
    });
  }
}

const notFound = () =>
  new NotFoundException({ code: 'CONTENT_NOT_FOUND', message: 'Không tìm thấy việc xử lý ảnh' });

/** An image file of the library that may be used for new content. */
function usableImage(a: AssetRow, what: string): void {
  if (a.kind !== 'image' || !a.storageKey)
    throw bad('MEDIA_NOT_IMAGE', `${what} phải là ảnh đã tải lên kho nội dung gốc`);
  if (a.archivedAt)
    throw new ConflictException({ code: 'CONTENT_STATE', message: `${what} đã được lưu trữ` });
  if (a.rightsStatus === 'restricted')
    throw bad('MEDIA_RIGHTS_RESTRICTED', `${what} “${a.title}” được đánh dấu Không được dùng`);
  if ((a.sizeBytes ?? 0) > MEDIA_LIMITS.imageMaxMb * 1024 * 1024)
    throw bad('MEDIA_TOO_LARGE', `${what} lớn hơn ${MEDIA_LIMITS.imageMaxMb} MB`);
}
