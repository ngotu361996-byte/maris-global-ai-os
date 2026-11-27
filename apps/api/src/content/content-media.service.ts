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
  processVideoSchema,
  VIDEO_COVER,
  workerJobInputSchemas,
  type ImagePreset,
  type ProcessVideo,
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

const { contentMediaOutputs, contentItems, contentItemVersions, devices, users } = schema;
type MediaInput = z.output<(typeof workerJobInputSchemas)['media.image']>;
type VideoInput = z.output<(typeof workerJobInputSchemas)['media.video']>;
type MediaKind = 'media.image' | 'media.video';
const KINDS: readonly string[] = ['media.image', 'media.video'];

const KIND = 'media.image';
const VIDEO = 'media.video';
/** A video job's outputs: its sizes and, when asked, one cover picture. */
type OutputName = ImagePreset | typeof VIDEO_COVER;
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

  /**
   * Queues a video job: the video is cut, resized to each chosen aspect ratio, cleaned up, given
   * the logo and the voice-over, and each result comes back as a new video item in draft.
   */
  processVideo(ctx: Ctx, assetId: string, raw: ProcessVideo): Promise<MediaJobResponse> {
    const { targetDeviceId, ...rest } = processVideoSchema.parse(raw);
    return this.db.withContext(ctx, async (tx) => {
      const asset = await this.content.assetIn(tx, ctx, assetId);
      usableFile(asset, 'video', 'Video gốc');
      if (rest.logoAssetId)
        usableImage(await this.content.assetIn(tx, ctx, rest.logoAssetId), 'Logo');
      let voiceVersion: number | null = null;
      if (rest.voiceItemId) voiceVersion = (await this.voice(tx, ctx, rest.voiceItemId)).version;
      if (rest.folderId) await this.content.folderIn(tx, ctx, rest.folderId, 'output');
      const job = await this.jobs.createIn(
        tx,
        ctx,
        {
          kind: VIDEO,
          title: `Xử lý video: ${asset.title}`.slice(0, 120),
          input: { assetId, ...rest, voiceVersion },
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
          kind: VIDEO,
          presets: rest.presets,
          logoAssetId: rest.logoAssetId,
          voiceItemId: rest.voiceItemId,
          voiceVersion,
          startSec: rest.startSec,
          endSec: rest.endSec,
        },
        ip: ctx.ip,
      });
      return (await this.responses(tx, ctx, [{ row: null, response: job }]))[0]!;
    });
  }

  list(ctx: Ctx, assetId: string): Promise<MediaJobsResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const asset = await this.content.assetIn(tx, ctx, assetId);
      const kind: MediaKind = asset.kind === 'video' ? VIDEO : KIND;
      const found = await this.jobs.findByInput(tx, ctx, kind, 'assetId', assetId, 20);
      const workers = await tx
        .select({ id: devices.id, name: devices.name, lastSeenAt: devices.lastSeenAt })
        .from(devices)
        .where(
          and(
            eq(devices.tenantId, ctx.tenantId),
            eq(devices.status, 'active'),
            isNull(devices.deletedAt),
            sql`${kind} = ANY(${devices.capabilities})`,
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
    if (!KINDS.includes((await this.jobs.get(ctx, jobId)).kind)) throw notFound();
    const job = await this.jobs.cancel(ctx, jobId);
    return this.db.withContext(
      ctx,
      async (tx) => (await this.responses(tx, ctx, [{ row: null, response: job }]))[0]!,
    );
  }

  // ---------------------------------------------------------------- worker side (device key)

  /** The image, video or logo of a job, for the worker running it, and nothing else. */
  async agentFile(deviceKey: string | undefined, jobId: string, assetId: string) {
    const { job } = await this.jobs.runningJob(deviceKey, jobId);
    if (!KINDS.includes(job.kind)) throw notFound();
    const input = job.input as MediaInput | VideoInput;
    if (assetId !== input.assetId && assetId !== input.logoAssetId) throw notFound();
    return this.content.assetFile(jobCtx(job), assetId);
  }

  /** The voice-over of a video job (the version chosen when it was queued), for its worker. */
  async agentVoice(deviceKey: string | undefined, jobId: string, itemId: string) {
    const { job } = await this.jobs.runningJob(deviceKey, jobId);
    if (job.kind !== VIDEO) throw notFound();
    const input = job.input as VideoInput;
    if (!input.voiceItemId || itemId !== input.voiceItemId || !input.voiceVersion) throw notFound();
    return this.content.versionFile(jobCtx(job), itemId, input.voiceVersion);
  }

  /**
   * One output image from the worker running the job. It must really be an image; it becomes a
   * new image item with one version. Sending the same size again returns the item made before.
   */
  async agentOutput(
    deviceKey: string | undefined,
    jobId: string,
    preset: OutputName,
    rawName: string,
    body: Readable,
  ): Promise<MediaOutputResponse> {
    const { job, device } = await this.jobs.runningJob(deviceKey, jobId);
    if (!KINDS.includes(job.kind)) throw notFound();
    const video = job.kind === VIDEO;
    const input = job.input as MediaInput | VideoInput;
    const asked =
      preset === VIDEO_COVER
        ? video && (input as VideoInput).coverAtSec !== null
        : (input.presets as string[]).includes(preset);
    if (!asked) throw bad('MEDIA_PRESET_NOT_IN_JOB', 'Việc này không yêu cầu kết quả đó');
    const outKind: 'image' | 'video' = video && preset !== VIDEO_COVER ? 'video' : 'image';
    const ctx = jobCtx(job);
    const before = await this.db.withContext(ctx, (tx) => this.output(tx, jobId, preset));
    if (before) return { itemId: before, duplicate: true };

    const file = await this.content.receiveFile(ctx, rawName, body);
    try {
      if (file.type.kind !== outKind)
        throw new HttpException(
          outKind === 'image'
            ? { code: 'MEDIA_OUTPUT_NOT_IMAGE', message: 'Kết quả gửi lên không phải ảnh' }
            : { code: 'MEDIA_OUTPUT_NOT_VIDEO', message: 'Kết quả gửi lên không phải video' },
          415,
        );
      const out = await this.db.withContext(ctx, async (tx) => {
        await this.jobs.lockRunningIn(tx, device, jobId);
        const again = await this.output(tx, jobId, preset);
        if (again) return { itemId: again, duplicate: true };
        const source = await this.content.assetIn(tx, ctx, input.assetId);
        const v = video ? (input as VideoInput) : null;
        const voice = v?.voiceItemId ? await this.voiceSources(tx, ctx, v) : null;
        const label = preset === VIDEO_COVER ? 'Ảnh bìa' : IMAGE_PRESET_INFO[preset].label;
        const info = preset === VIDEO_COVER ? null : IMAGE_PRESET_INFO[preset];
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
            title:
              `${source.title} · ${video && preset !== VIDEO_COVER ? `Video ${label}` : label}`.slice(
                0,
                200,
              ),
            kind: outKind,
            folderId,
            tags: ['media-worker', preset],
          }),
          null,
        );
        item = await this.content.addFileVersionIn(tx, ctx, item, file, {
          sourceAssetIds: [
            ...new Set([
              input.assetId,
              ...(input.logoAssetId ? [input.logoAssetId] : []),
              ...(voice?.sources ?? []),
            ]),
          ],
          workerJobId: jobId,
          note: outputNote(device.name, label, info, input, v, voice?.title ?? null),
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
            kind: job.kind,
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

  /** A voice-over that a video job may use: an audio item with a file, not rejected or archived. */
  private async voice(tx: Tx, ctx: Ctx, itemId: string) {
    const item = await this.content.itemIn(tx, ctx, itemId);
    if (item.kind !== 'audio' || item.currentVersion < 1)
      throw bad('MEDIA_VOICE_INVALID', 'Giọng đọc phải là mục âm thanh trong kho thành phẩm');
    if (item.status === 'rejected' || item.status === 'archived')
      throw bad('MEDIA_VOICE_INVALID', `Giọng đọc “${item.title}” đã bị từ chối hoặc lưu trữ`);
    const [version] = await tx
      .select()
      .from(contentItemVersions)
      .where(
        and(
          eq(contentItemVersions.itemId, item.id),
          eq(contentItemVersions.version, item.currentVersion),
        ),
      );
    if (!version?.storageKey || !version.mime?.startsWith('audio/'))
      throw bad('MEDIA_VOICE_INVALID', 'Giọng đọc chưa có tệp âm thanh');
    if ((version.sizeBytes ?? 0) > MEDIA_LIMITS.videoMaxMb * 1024 * 1024)
      throw bad('MEDIA_TOO_LARGE', `Giọng đọc lớn hơn ${MEDIA_LIMITS.videoMaxMb} MB`);
    return version;
  }

  /** The voice-over's title and the sources of the version used, so rights carry over. */
  private async voiceSources(tx: Tx, ctx: Ctx, input: VideoInput) {
    const item = await this.content.itemIn(tx, ctx, input.voiceItemId!);
    const [version] = await tx
      .select({ sources: contentItemVersions.sourceAssetIds })
      .from(contentItemVersions)
      .where(
        and(
          eq(contentItemVersions.itemId, item.id),
          eq(contentItemVersions.version, input.voiceVersion ?? item.currentVersion),
        ),
      );
    return { title: item.title, sources: version?.sources ?? [] };
  }

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
    const order = (p: string) => (p === VIDEO_COVER ? 99 : IMAGE_PRESETS.indexOf(p as ImagePreset));
    return jobs.map(({ row, response: j }) => {
      const input = j.input as MediaInput | VideoInput;
      const video = j.kind === VIDEO;
      return {
        id: j.id,
        kind: video ? VIDEO : KIND,
        title: j.title,
        status: j.status,
        progress: j.progress,
        progressNote: j.progressNote,
        presets: input.presets,
        logoAssetId: input.logoAssetId ?? null,
        voiceItemId: ('voiceItemId' in input ? input.voiceItemId : null) ?? null,
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
            preset: o.preset as OutputName,
            kind: video && o.preset !== VIDEO_COVER ? ('video' as const) : ('image' as const),
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

/** The version note: who made it, which size, and what was added. */
function outputNote(
  deviceName: string,
  label: string,
  info: { width: number | null; height: number | null } | null,
  input: MediaInput | VideoInput,
  video: VideoInput | null,
  voiceTitle: string | null,
): string {
  const parts = [`${label}${info?.width ? ` ${info.width}×${info.height}` : ''}`];
  if (video) {
    if (video.startSec > 0 || video.endSec !== null)
      parts.push(
        `cắt ${clock(video.startSec)}–${video.endSec === null ? 'hết' : clock(video.endSec)}`,
      );
    if (voiceTitle)
      parts.push(
        `giọng đọc “${voiceTitle}” (${video.voiceMix === 'replace' ? 'thay tiếng gốc' : 'trộn tiếng gốc'})`,
      );
    if (video.denoise) parts.push('giảm nhiễu');
    if (video.sharpen) parts.push('tăng nét');
  }
  if (input.logoAssetId) parts.push('gắn logo');
  return `Media Worker ${deviceName}: ${parts.join(', ')}`;
}

const clock = (sec: number) => {
  const s = Math.floor(sec);
  const t = `${Math.floor((s % 3600) / 60)}:${String(s % 60).padStart(2, '0')}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${t.padStart(5, '0')}` : t;
};

/** An image file of the library that may be used for new content. */
function usableImage(a: AssetRow, what: string): void {
  usableFile(a, 'image', what);
}

/** A file of the library, of that kind, that may be used for new content. */
function usableFile(a: AssetRow, kind: 'image' | 'video', what: string): void {
  if (a.kind !== kind || !a.storageKey)
    throw kind === 'image'
      ? bad('MEDIA_NOT_IMAGE', `${what} phải là ảnh đã tải lên kho nội dung gốc`)
      : bad('MEDIA_NOT_VIDEO', `${what} phải là video đã tải lên kho nội dung gốc`);
  if (a.archivedAt)
    throw new ConflictException({ code: 'CONTENT_STATE', message: `${what} đã được lưu trữ` });
  if (a.rightsStatus === 'restricted')
    throw bad('MEDIA_RIGHTS_RESTRICTED', `${what} “${a.title}” được đánh dấu Không được dùng`);
  const maxMb = kind === 'image' ? MEDIA_LIMITS.imageMaxMb : MEDIA_LIMITS.videoMaxMb;
  if ((a.sizeBytes ?? 0) > maxMb * 1024 * 1024)
    throw bad('MEDIA_TOO_LARGE', `${what} lớn hơn ${maxMb} MB`);
}
