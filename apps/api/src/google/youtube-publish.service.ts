import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  YOUTUBE_COSTS,
  YOUTUBE_RULES,
  type ListYoutubeUploads,
  type ScheduleYoutube,
  type YoutubeUploadResponse,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { qaReport } from '../content/content-qa';
import { DbService, type Tx } from '../db/db.service';
import { LocalFileStorage } from '../files/file-storage';
import { SecretVaultService } from '../secrets/secret-vault.service';
import { GoogleApiService, GoogleError, type GoogleRequest } from './google-api.service';
import { quotaResetAt } from './quota';
import {
  effectivePrivacy,
  metadataErrors,
  receivedBytes,
  shortProblem,
  uploadWarnings,
} from './youtube-rules';

const {
  youtubeUploads,
  googleChannels,
  googleConnections,
  googleApps,
  contentItems,
  contentItemVersions,
  users,
} = schema;
type UploadRow = typeof youtubeUploads.$inferSelect;
type ChannelRow = typeof googleChannels.$inferSelect;
type VersionRow = typeof contentItemVersions.$inferSelect;
type Stage = Record<string, string | number | boolean>;

const TICK_MS = 30_000;
const CLAIM = 2;
/** How long one run may hold an upload; a big video fits inside. */
const LOCK_MIN = 90;
const UPLOAD_TIMEOUT_MS = 80 * 60_000;
const MAX_ATTEMPTS = 5;
/** YouTube processes an uploaded video; MARIS looks again this often, for at most this long. */
const PROCESS_POLL_SEC = 60;
const PROCESS_MAX_MIN = 60;
/** An upload that cannot go out within this long after it was asked for is given up. */
const MAX_DELAY_H = 48;
const MAX_AHEAD_DAYS = 90;
/** A scheduled time this close is treated as "now" (YouTube needs publishAt in the future). */
const MIN_AHEAD_MIN = 15;
const SESSION_SCOPE = 'youtube-session';
/** Units one upload uses: the upload, a thumbnail and a few status reads. */
const UPLOAD_UNITS = YOUTUBE_COSTS.upload + YOUTUBE_COSTS.thumbnail + 20 * YOUTUBE_COSTS.list;

interface VideoResource {
  id?: string;
  status?: {
    uploadStatus?: string;
    privacyStatus?: string;
    rejectionReason?: string;
    failureReason?: string;
    publishAt?: string;
  };
}

class Retry extends Error {
  constructor(
    readonly at: Date,
    readonly countsAsAttempt: boolean,
    message: string,
  ) {
    super(message);
  }
}

export const youtubeUrl = (videoId: string, format: 'video' | 'short') =>
  format === 'short'
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;

/**
 * Uploading approved videos to YouTube (spec Part 17). Uploads wait in google.youtube_uploads; an
 * uploader in this process claims due ones every 30 seconds and runs each as the person who asked,
 * through the Google gateway (YouTube quota).
 *
 * YouTube's resumable upload lets MARIS ask how much of a file arrived, so an upload cut off by a
 * network error or a restart goes on from where it stopped and never makes a second video. A video
 * scheduled for later is uploaded at once as private with status.publishAt: YouTube makes it
 * public at that time, even if the computer running MARIS is off.
 */
@Injectable()
export class YoutubePublishService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(YoutubePublishService.name);
  private readonly storage: LocalFileStorage;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly api: GoogleApiService,
    private readonly vault: SecretVaultService,
    private readonly audit: AuditService,
  ) {
    this.storage = new LocalFileStorage(join(config.FILE_STORAGE_DIR, 'content'));
  }

  onModuleInit(): void {
    if (!this.config.YOUTUBE_UPLOADER_ENABLED) return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.error(e)), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async schedule(ctx: Ctx, input: ScheduleYoutube): Promise<YoutubeUploadResponse[]> {
    const now = Date.now();
    let publishAt = input.at ? new Date(input.at) : null;
    if (publishAt && publishAt.getTime() < now + MIN_AHEAD_MIN * 60_000) {
      if (publishAt.getTime() < now - 5 * 60_000)
        throw new BadRequestException({
          code: 'YOUTUBE_PAST',
          message: 'Thời điểm công khai đã qua',
        });
      publishAt = null;
    }
    if (publishAt && publishAt.getTime() > now + MAX_AHEAD_DAYS * 86400_000)
      throw new BadRequestException({
        code: 'YOUTUBE_TOO_FAR',
        message: `Chỉ hẹn giờ trước tối đa ${MAX_AHEAD_DAYS} ngày`,
      });
    if (publishAt && input.privacy !== 'public')
      throw new BadRequestException({
        code: 'YOUTUBE_SCHEDULE_PRIVACY',
        message: 'Hẹn giờ chỉ dùng cho video Công khai: YouTube giữ video riêng tư tới giờ hẹn',
      });
    const problems = metadataErrors(input);
    if (problems.length)
      throw new BadRequestException({ code: 'YOUTUBE_METADATA', message: problems.join('. ') });

    const ids = await this.db.withContext(ctx, async (tx) => {
      // One tenant at a time, so two people cannot pass the day's quota together.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`youtube-uploads:${ctx.tenantId}`}))`,
      );
      const [app] = await tx.select().from(googleApps).where(eq(googleApps.tenantId, ctx.tenantId));
      if (!app)
        throw new ConflictException({
          code: 'GOOGLE_APP_MISSING',
          message: 'Chưa cài OAuth client Google trong Trung tâm Google',
        });
      if (publishAt && !app.youtubeAudited)
        throw new ConflictException({
          code: 'YOUTUBE_NOT_AUDITED',
          message:
            'Dự án Google chưa được YouTube xét duyệt nên YouTube giữ mọi video tải qua API ở chế độ Riêng tư; không hẹn giờ công khai được. Chọn Đăng ngay rồi mở công khai trong YouTube Studio.',
        });
      const { item, v } = await this.approvedVersion(tx, ctx.tenantId, input.itemId);
      if (!v.storageKey || !v.mime?.startsWith('video/'))
        throw new BadRequestException({
          code: 'YOUTUBE_NOT_VIDEO',
          message: 'YouTube chỉ nhận video; thành phẩm này không phải video',
        });
      if ((v.sizeBytes ?? 0) > YOUTUBE_RULES.videoMaxMb * 1024 * 1024)
        throw new BadRequestException({
          code: 'YOUTUBE_MEDIA',
          message: `Video lớn hơn ${YOUTUBE_RULES.videoMaxMb / 1024} GB`,
        });
      if (input.format === 'short') {
        const p = shortProblem(v.mediaWidth, v.mediaHeight, v.durationMs);
        if (p)
          throw new BadRequestException({
            code: 'YOUTUBE_SHORT',
            message: `${p}. Chọn đăng thành Video thường.`,
          });
      }

      let thumbnailVersion: number | null = null;
      if (input.thumbnailItemId) {
        const t = await this.approvedVersion(tx, ctx.tenantId, input.thumbnailItemId);
        if (!t.v.storageKey || !['image/jpeg', 'image/png'].includes(t.v.mime ?? ''))
          throw new BadRequestException({
            code: 'YOUTUBE_THUMBNAIL',
            message: 'Ảnh bìa cần là ảnh JPEG hoặc PNG',
          });
        if ((t.v.sizeBytes ?? 0) > YOUTUBE_RULES.thumbnailMaxMb * 1024 * 1024)
          throw new BadRequestException({
            code: 'YOUTUBE_THUMBNAIL',
            message: `Ảnh bìa tối đa ${YOUTUBE_RULES.thumbnailMaxMb} MB`,
          });
        thumbnailVersion = t.v.version;
      }

      const channels = await tx
        .select()
        .from(googleChannels)
        .where(
          and(
            eq(googleChannels.tenantId, ctx.tenantId),
            inArray(googleChannels.id, input.channelIds),
          ),
        );
      if (channels.length !== new Set(input.channelIds).size)
        throw new NotFoundException({
          code: 'YOUTUBE_CHANNEL_NOT_FOUND',
          message: 'Không tìm thấy kênh YouTube',
        });
      for (const c of channels) {
        if (!c.enabled || c.removedAt)
          throw new ConflictException({
            code: 'YOUTUBE_CHANNEL_OFF',
            message: `Kênh “${c.title}” chưa được bật trong Trung tâm Google`,
          });
        const [conn] = await tx
          .select()
          .from(googleConnections)
          .where(eq(googleConnections.id, c.connectionId));
        if (!conn || conn.status !== 'active')
          throw new ConflictException({
            code: 'GOOGLE_NOT_CONNECTED',
            message: `Tài khoản Google của kênh “${c.title}” cần kết nối lại`,
          });
        if (!conn.scopes.includes('https://www.googleapis.com/auth/youtube.upload'))
          throw new ConflictException({
            code: 'GOOGLE_PERMISSION',
            message: `Tài khoản ${conn.email} chưa cho MARIS quyền tải video lên YouTube. Bấm Kết nối Google và đánh dấu quyền YouTube.`,
          });
      }

      // The day's quota must hold this upload with the ones still waiting.
      const used = await this.api.usedToday(tx, ctx.tenantId);
      const [{ waiting }] = await tx
        .select({ waiting: sql<number>`count(*)::int` })
        .from(youtubeUploads)
        .where(
          and(
            eq(youtubeUploads.tenantId, ctx.tenantId),
            inArray(youtubeUploads.status, ['scheduled', 'uploading']),
          ),
        );
      const left = app.youtubeQuota - used - waiting * UPLOAD_UNITS;
      if (left < channels.length * UPLOAD_UNITS)
        throw new ConflictException({
          code: 'GOOGLE_QUOTA',
          message: `Hạn mức YouTube hôm nay (${app.youtubeQuota.toLocaleString('vi-VN')} đơn vị, đã dùng ${used.toLocaleString('vi-VN')}) chỉ đủ thêm ${Math.max(0, Math.floor(left / UPLOAD_UNITS))} video. Google tính lại lúc ${quotaResetAt(new Date()).toISOString()}; hoặc xin Google tăng hạn mức.`,
        });

      const existing = await tx
        .select({ channelId: youtubeUploads.channelId, status: youtubeUploads.status })
        .from(youtubeUploads)
        .where(
          and(
            eq(youtubeUploads.tenantId, ctx.tenantId),
            eq(youtubeUploads.itemId, item.id),
            eq(youtubeUploads.version, v.version),
            sql`${youtubeUploads.status} <> 'cancelled'`,
          ),
        );
      const out: string[] = [];
      for (const c of channels) {
        const dup = existing.find((e) => e.channelId === c.id);
        if (dup)
          throw new ConflictException({
            code: 'YOUTUBE_DUPLICATE',
            message: `Phiên bản ${v.version} đã ${dup.status === 'published' ? 'có trên' : 'đang chờ tải lên'} kênh “${c.title}”`,
          });
        const id = uuidv7();
        const warnings = uploadWarnings({
          format: input.format,
          durationMs: v.durationMs,
          longUploads: c.longUploads,
          audited: app.youtubeAudited,
          privacy: input.privacy,
        });
        await tx.insert(youtubeUploads).values({
          id,
          tenantId: ctx.tenantId,
          itemId: item.id,
          version: v.version,
          channelId: c.id,
          format: input.format,
          title: input.title,
          description: input.description,
          tags: input.tags,
          categoryId: input.categoryId,
          privacy: input.privacy,
          publishAt,
          madeForKids: input.madeForKids,
          syntheticMedia: input.syntheticMedia,
          thumbnailItemId: input.thumbnailItemId,
          thumbnailVersion,
          warnings,
          nextAttemptAt: new Date(),
          createdBy: ctx.userId,
        });
        await this.audit.append(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'google.youtube_scheduled',
          targetType: 'youtube_upload',
          targetId: id,
          metadata: {
            itemId: item.id,
            version: v.version,
            channelId: c.id,
            format: input.format,
            privacy: input.privacy,
            publishAt: publishAt?.toISOString() ?? null,
            madeForKids: input.madeForKids,
            syntheticMedia: input.syntheticMedia,
          },
          ip: ctx.ip,
        });
        out.push(id);
      }
      return out;
    });
    const all = await this.list(ctx, { itemId: input.itemId });
    return all.filter((u) => ids.includes(u.id));
  }

  async list(ctx: Ctx, filter: ListYoutubeUploads): Promise<YoutubeUploadResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select({
          u: youtubeUploads,
          itemTitle: contentItems.title,
          ch: googleChannels,
          name: users.displayName,
        })
        .from(youtubeUploads)
        .innerJoin(contentItems, eq(contentItems.id, youtubeUploads.itemId))
        .innerJoin(googleChannels, eq(googleChannels.id, youtubeUploads.channelId))
        .leftJoin(users, eq(users.id, youtubeUploads.createdBy))
        .where(
          and(
            eq(youtubeUploads.tenantId, ctx.tenantId),
            filter.status ? eq(youtubeUploads.status, filter.status) : undefined,
            filter.itemId ? eq(youtubeUploads.itemId, filter.itemId) : undefined,
          ),
        )
        .orderBy(desc(youtubeUploads.createdAt), desc(youtubeUploads.id))
        .limit(200);
      return rows.map(({ u, itemTitle, ch, name }) => uploadResponse(u, itemTitle, ch, name));
    });
  }

  async cancel(ctx: Ctx, id: string): Promise<YoutubeUploadResponse> {
    await this.change(ctx, id, ['scheduled', 'failed'], 'google.youtube_cancelled', (u) => {
      // A video already on YouTube stays there; cancelling only stops MARIS working on it.
      if (u.videoId)
        throw new ConflictException({
          code: 'YOUTUBE_STATE',
          message: 'Video đã lên YouTube; xóa hoặc sửa trong YouTube Studio',
        });
      return { status: 'cancelled' as const };
    });
    return this.one(ctx, id);
  }

  /** Puts a failed upload back in the queue. Its row and upload session are reused. */
  async retry(ctx: Ctx, id: string): Promise<YoutubeUploadResponse> {
    await this.change(ctx, id, ['failed'], 'google.youtube_retried', (u) => ({
      status: u.videoId ? ('processing' as const) : ('scheduled' as const),
      attempts: 0,
      nextAttemptAt: new Date(),
      errorCode: null,
      errorMessage: null,
    }));
    return this.one(ctx, id);
  }

  /** Claims due uploads and runs them. Called every 30 seconds; tests call it directly. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      // An upload whose lock ran out stopped half-way; its session tells where to go on from.
      const claimed = await this.db.withSystem('youtube_uploader', async (tx) => {
        const due = await tx.execute<{ id: string }>(sql`
          SELECT id FROM google.youtube_uploads
          WHERE status IN ('scheduled', 'uploading', 'processing') AND next_attempt_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY next_attempt_at
          LIMIT ${CLAIM}
          FOR UPDATE SKIP LOCKED`);
        const ids = [...due].map((r) => r.id);
        if (!ids.length) return [];
        return tx
          .update(youtubeUploads)
          .set({
            status: sql`CASE WHEN ${youtubeUploads.status} = 'scheduled' THEN 'uploading' ELSE ${youtubeUploads.status} END`,
            lockedUntil: new Date(Date.now() + LOCK_MIN * 60_000),
            updatedAt: new Date(),
          })
          .where(inArray(youtubeUploads.id, ids))
          .returning();
      });
      for (const u of claimed) await this.process(u);
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  // ------------------------------------------------------------------------------ one upload

  private async process(u: UploadRow): Promise<void> {
    const ctx = { tenantId: u.tenantId, userId: u.createdBy };
    const stage: Stage = { ...u.stage };
    const warnings = [...u.warnings];
    const save = (patch: Stage, extra: Partial<UploadRow> = {}) => {
      Object.assign(stage, patch);
      return this.db.withContext(ctx, (tx) =>
        tx
          .update(youtubeUploads)
          .set({ stage, warnings, updatedAt: new Date(), ...extra })
          .where(eq(youtubeUploads.id, u.id)),
      );
    };
    try {
      const { v, channel, thumb, audited } = await this.db.withContext(ctx, (tx) =>
        this.load(tx, u),
      );
      const call = <T>(req: Omit<GoogleRequest, 'auth' | 'channelId' | 'service'>) =>
        this.api.call<T>(ctx, {
          service: 'youtube',
          auth: { kind: 'connection', connectionId: channel.connectionId },
          channelId: channel.id,
          ...req,
        });

      if (!stage.videoId) {
        const video = await this.upload(u, stage, save, call, v, audited);
        if (!video) return;
        await save(
          { videoId: video.id!, since: Date.now() },
          {
            videoId: video.id!,
            youtubePrivacy: video.status?.privacyStatus?.slice(0, 20) ?? null,
            status: 'processing',
          },
        );
        await this.db.withContext(ctx, (tx) =>
          this.audit.append(tx, {
            tenantId: u.tenantId,
            actorUserId: u.createdBy,
            action: 'google.youtube_uploaded',
            targetType: 'youtube_upload',
            targetId: u.id,
            metadata: { itemId: u.itemId, version: u.version, videoId: video.id },
          }),
        );
      }
      const videoId = String(stage.videoId);

      if (thumb && !stage.thumb) {
        try {
          await call({
            call: 'thumbnail',
            priority: 'essential',
            method: 'POST',
            host: 'api',
            path: '/upload/youtube/v3/thumbnails/set',
            params: { videoId, uploadType: 'media' },
            headers: { 'Content-Type': thumb.mime! },
            body: await openAsBlob(this.storage.filePath(thumb.storageKey!), { type: thumb.mime! }),
            timeoutMs: 5 * 60_000,
          });
          await save({ thumb: 'done' });
        } catch (e) {
          // Stops and passing errors try again later; a refusal from YouTube is only a warning.
          if (
            e instanceof GoogleError &&
            (e.getStatus() === 429 || e.kind === 'network' || e.kind === 'transient')
          )
            throw e;
          warnings.push(
            `YouTube không nhận ảnh bìa (${e instanceof Error ? e.message : String(e)}). Kênh cần xác minh số điện thoại để dùng ảnh bìa tùy chỉnh.`,
          );
          await save({ thumb: 'failed' });
        }
      }

      const r = await call<{ items?: VideoResource[] }>({
        call: 'list',
        priority: 'normal',
        method: 'GET',
        host: 'api',
        path: '/youtube/v3/videos',
        params: { part: 'status', id: videoId },
      });
      const s = r.body.items?.[0]?.status;
      const state = s?.uploadStatus;
      if (state === 'rejected' || state === 'failed' || state === 'deleted')
        throw new GoogleError(
          502,
          state === 'rejected' ? 'YOUTUBE_REJECTED' : 'YOUTUBE_FAILED',
          `YouTube ${state === 'rejected' ? 'từ chối' : 'không xử lý được'} video: ${s?.rejectionReason ?? s?.failureReason ?? state}`,
        );
      const tooLong = Date.now() - Number(stage.since ?? Date.now()) > PROCESS_MAX_MIN * 60_000;
      if (state !== 'processed' && !tooLong) {
        await this.db.withContext(ctx, (tx) =>
          tx
            .update(youtubeUploads)
            .set({
              status: 'processing',
              lockedUntil: null,
              nextAttemptAt: new Date(Date.now() + PROCESS_POLL_SEC * 1000),
              youtubePrivacy: s?.privacyStatus?.slice(0, 20) ?? u.youtubePrivacy,
              updatedAt: new Date(),
            })
            .where(eq(youtubeUploads.id, u.id)),
        );
        return;
      }
      if (state !== 'processed')
        warnings.push(
          `YouTube vẫn đang xử lý video sau ${PROCESS_MAX_MIN} phút; xem trong YouTube Studio`,
        );
      const privacy = s?.privacyStatus ?? null;
      const asked = effectivePrivacy(u.privacy, audited);
      if (privacy === 'private' && asked !== 'private' && !u.publishAt)
        warnings.push(
          'YouTube giữ video ở chế độ Riêng tư (dự án Google chưa được xét duyệt hoặc video bị hạn chế); kiểm tra trong YouTube Studio',
        );
      await this.done(u, videoId, privacy, warnings);
    } catch (e) {
      await this.failed(u, e, stage, warnings);
    }
  }

  /**
   * Sends the file with YouTube's resumable upload: opens a session (once), asks it how much it
   * has when a send was cut off, and sends the rest. Returns the video when YouTube has all of it.
   */
  private async upload(
    u: UploadRow,
    stage: Stage,
    save: (patch: Stage) => Promise<unknown>,
    call: <T>(
      req: Omit<GoogleRequest, 'auth' | 'channelId' | 'service'>,
    ) => Promise<{ status: number; headers: Headers; body: T }>,
    v: VersionRow,
    audited: boolean,
  ): Promise<VideoResource | null> {
    const path = this.storage.filePath(v.storageKey!);
    const file = await openAsBlob(path, { type: v.mime! });
    const size = file.size;
    const ctx = { tenantId: u.tenantId, userId: u.createdBy };
    let from = 0;
    if (stage.session) {
      const session = this.vault.openFor(SESSION_SCOPE, u.tenantId, u.id, String(stage.session));
      const q = await call<VideoResource>({
        priority: 'essential',
        method: 'PUT',
        host: 'api',
        path: '/upload/youtube/v3/videos',
        sessionUrl: session,
        headers: { 'Content-Range': `bytes */${size}` },
        accept: [308],
      }).catch(async (e: unknown) => {
        // The session is gone (after a week): nothing was made, start a new one.
        if (e instanceof GoogleError && e.code === 'GOOGLE_NOT_FOUND') {
          delete stage.session;
          await save({ sent: 0 });
          return null;
        }
        throw e;
      });
      if (q && q.status !== 308) return q.body;
      if (q) from = receivedBytes(q.headers.get('range'));
    }
    if (!stage.session) {
      const publishAt =
        u.publishAt && u.publishAt.getTime() > Date.now() + 2 * 60_000 ? u.publishAt : null;
      const privacy = publishAt ? 'private' : effectivePrivacy(u.privacy, audited);
      const r = await call<Record<string, unknown>>({
        call: 'upload',
        priority: 'essential',
        method: 'POST',
        host: 'api',
        path: '/upload/youtube/v3/videos',
        params: { uploadType: 'resumable', part: 'snippet,status' },
        headers: { 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': v.mime! },
        json: {
          snippet: {
            title: u.title,
            description: u.description,
            tags: u.tags,
            categoryId: u.categoryId,
          },
          status: {
            privacyStatus: privacy,
            ...(publishAt ? { publishAt: publishAt.toISOString() } : {}),
            selfDeclaredMadeForKids: u.madeForKids,
            containsSyntheticMedia: u.syntheticMedia,
          },
        },
      });
      const location = r.headers.get('location');
      // The session must be on Google's own host: the access token goes with every send.
      if (!location || !sameOrigin(location, this.config.GOOGLE_API_URL))
        throw new GoogleError(502, 'GOOGLE_API_ERROR', 'YouTube không trả về địa chỉ tải lên');
      if (u.publishAt && !publishAt)
        await this.db.withContext(ctx, (tx) =>
          tx
            .update(youtubeUploads)
            .set({
              warnings: sql`array_append(${youtubeUploads.warnings}, ${'Tải lên trễ hơn giờ hẹn nên video công khai ngay khi YouTube xử lý xong'})`,
            })
            .where(eq(youtubeUploads.id, u.id)),
        );
      await save({
        session: this.vault.sealFor(SESSION_SCOPE, u.tenantId, u.id, location),
        size,
        sent: 0,
      });
      from = 0;
    }
    const session = this.vault.openFor(SESSION_SCOPE, u.tenantId, u.id, String(stage.session));
    const r = await call<VideoResource>({
      priority: 'essential',
      method: 'PUT',
      host: 'api',
      path: '/upload/youtube/v3/videos',
      sessionUrl: session,
      headers: {
        'Content-Type': v.mime!,
        ...(from > 0 ? { 'Content-Range': `bytes ${from}-${size - 1}/${size}` } : {}),
      },
      body: from > 0 ? file.slice(from) : file,
      accept: [308],
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (r.status === 308) {
      const got = receivedBytes(r.headers.get('range'));
      await save({ sent: got });
      throw new Retry(new Date(Date.now() + 60_000), false, `YouTube mới nhận ${got}/${size} byte`);
    }
    if (!r.body.id) throw new GoogleError(502, 'GOOGLE_API_ERROR', 'YouTube không trả về mã video');
    return r.body;
  }

  private async done(
    u: UploadRow,
    videoId: string,
    privacy: string | null,
    warnings: string[],
  ): Promise<void> {
    const ctx = { tenantId: u.tenantId, userId: u.createdBy };
    const url = youtubeUrl(videoId, u.format);
    await this.db.withContext(ctx, async (tx) => {
      const now = new Date();
      await tx
        .update(youtubeUploads)
        .set({
          status: 'published',
          videoId,
          youtubePrivacy: privacy?.slice(0, 20) ?? null,
          warnings,
          publishedAt: now,
          lockedUntil: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(youtubeUploads.id, u.id));
      await this.audit.append(tx, {
        tenantId: u.tenantId,
        actorUserId: u.createdBy,
        action: 'google.youtube_published',
        targetType: 'youtube_upload',
        targetId: u.id,
        metadata: {
          itemId: u.itemId,
          version: u.version,
          videoId,
          privacy,
          warnings: warnings.length,
        },
      });
      // The first upload of an approved item marks it published, with where it went.
      const [marked] = await tx
        .update(contentItems)
        .set({ status: 'published', publishedUrl: url, publishedAt: now, updatedAt: now })
        .where(and(eq(contentItems.id, u.itemId), eq(contentItems.status, 'approved')))
        .returning({ id: contentItems.id });
      if (marked)
        await this.audit.append(tx, {
          tenantId: u.tenantId,
          actorUserId: u.createdBy,
          action: 'content.item.published',
          targetType: 'content_item',
          targetId: u.itemId,
          metadata: { url, via: 'youtube', uploadId: u.id },
        });
    });
  }

  private async failed(u: UploadRow, e: unknown, stage: Stage, warnings: string[]): Promise<void> {
    const ctx = { tenantId: u.tenantId, userId: u.createdBy };
    const code =
      e instanceof GoogleError ? e.code : e instanceof Retry ? 'YOUTUBE_RETRY' : 'YOUTUBE_ERROR';
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    let retry: Retry | null = e instanceof Retry ? e : null;
    if (!retry && e instanceof GoogleError) {
      // Stopped by the quota or by Google before anything was done: try again later.
      if (e.getStatus() === 429)
        retry = new Retry(e.retryAt ?? new Date(Date.now() + 15 * 60_000), false, message);
      // A cut connection or a passing error: the session says where to go on from.
      else if ((e.kind === 'network' || e.kind === 'transient') && u.attempts + 1 < MAX_ATTEMPTS)
        retry = new Retry(new Date(Date.now() + 2 * 60_000 * (u.attempts + 1)), true, message);
    }
    const tooLate = Date.now() - u.createdAt.getTime() > MAX_DELAY_H * 3600_000;
    const status = stage.videoId ? 'processing' : 'uploading';
    await this.db.withContext(ctx, async (tx) => {
      if (retry && !tooLate) {
        await tx
          .update(youtubeUploads)
          .set({
            status: status === 'uploading' && !stage.session ? 'scheduled' : status,
            attempts: u.attempts + (retry.countsAsAttempt ? 1 : 0),
            nextAttemptAt: retry.at,
            lockedUntil: null,
            stage,
            warnings,
            errorCode: code,
            errorMessage: message,
            updatedAt: new Date(),
          })
          .where(eq(youtubeUploads.id, u.id));
        return;
      }
      await tx
        .update(youtubeUploads)
        .set({
          status: 'failed',
          attempts: u.attempts + 1,
          lockedUntil: null,
          stage,
          warnings,
          errorCode: code,
          errorMessage: tooLate
            ? `Quá ${MAX_DELAY_H} giờ mà chưa tải lên được: ${message}`
            : message,
          updatedAt: new Date(),
        })
        .where(eq(youtubeUploads.id, u.id));
      await this.audit.append(tx, {
        tenantId: u.tenantId,
        actorUserId: u.createdBy,
        action: 'google.youtube_failed',
        targetType: 'youtube_upload',
        targetId: u.id,
        metadata: { code, attempts: u.attempts + 1 },
      });
    });
  }

  private async approvedVersion(tx: Tx, tenantId: string, itemId: string) {
    const [item] = await tx
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.id, itemId), eq(contentItems.tenantId, tenantId)));
    if (!item)
      throw new NotFoundException({
        code: 'CONTENT_ITEM_NOT_FOUND',
        message: 'Không tìm thấy thành phẩm',
      });
    if (item.status !== 'approved' && item.status !== 'published')
      throw new ConflictException({
        code: 'YOUTUBE_NOT_APPROVED',
        message: `“${item.title}” chưa được duyệt; chỉ đăng thành phẩm đã duyệt`,
      });
    const [v] = await tx
      .select()
      .from(contentItemVersions)
      .where(
        and(
          eq(contentItemVersions.itemId, item.id),
          eq(contentItemVersions.version, item.currentVersion),
        ),
      );
    if (!v)
      throw new ConflictException({
        code: 'YOUTUBE_NO_VERSION',
        message: 'Thành phẩm chưa có phiên bản',
      });
    const qa = qaReport({
      kind: item.kind,
      platform: item.platform,
      language: item.language,
      version: v.version,
      body: v.storageKey ? null : (v.body ?? ''),
      mime: v.storageKey ? v.mime : null,
      width: v.mediaWidth,
      height: v.mediaHeight,
      durationMs: v.durationMs,
    });
    if (qa.status === 'fail')
      throw new ConflictException({
        code: 'CONTENT_QA_FAILED',
        message: `“${item.title}” chưa đạt kiểm định: ${qa.checks.find((c) => c.level === 'error')?.message ?? ''}`,
      });
    return { item, v };
  }

  private async load(tx: Tx, u: UploadRow) {
    const [item] = await tx.select().from(contentItems).where(eq(contentItems.id, u.itemId));
    const [v] = await tx
      .select()
      .from(contentItemVersions)
      .where(
        and(eq(contentItemVersions.itemId, u.itemId), eq(contentItemVersions.version, u.version)),
      );
    const [channel] = await tx
      .select()
      .from(googleChannels)
      .where(eq(googleChannels.id, u.channelId));
    const [app] = await tx.select().from(googleApps).where(eq(googleApps.tenantId, u.tenantId));
    if (!item || !v?.storageKey || !channel)
      throw new GoogleError(409, 'YOUTUBE_GONE', 'Thành phẩm hoặc kênh không còn');
    if (item.status === 'archived' && !u.videoId)
      throw new GoogleError(
        409,
        'YOUTUBE_ARCHIVED',
        'Thành phẩm đã được lưu trữ, không tải lên nữa',
      );
    if ((!channel.enabled || channel.removedAt) && !u.videoId)
      throw new GoogleError(
        409,
        'YOUTUBE_CHANNEL_OFF',
        `Kênh “${channel.title}” đã bị tắt trong Trung tâm Google`,
      );
    let thumb: VersionRow | null = null;
    if (u.thumbnailItemId && u.thumbnailVersion) {
      const [t] = await tx
        .select()
        .from(contentItemVersions)
        .where(
          and(
            eq(contentItemVersions.itemId, u.thumbnailItemId),
            eq(contentItemVersions.version, u.thumbnailVersion),
          ),
        );
      thumb = t?.storageKey ? t : null;
    }
    return { v, channel: channel as ChannelRow, thumb, audited: app?.youtubeAudited ?? false };
  }

  private async change(
    ctx: Ctx,
    id: string,
    from: UploadRow['status'][],
    action: string,
    patch: (u: UploadRow) => Partial<UploadRow>,
  ): Promise<void> {
    await this.db.withContext(ctx, async (tx) => {
      const [u] = await tx
        .select()
        .from(youtubeUploads)
        .where(and(eq(youtubeUploads.id, id), eq(youtubeUploads.tenantId, ctx.tenantId)))
        .for('update');
      if (!u)
        throw new NotFoundException({
          code: 'YOUTUBE_UPLOAD_NOT_FOUND',
          message: 'Không tìm thấy lượt tải lên',
        });
      if (!from.includes(u.status))
        throw new ConflictException({
          code: 'YOUTUBE_STATE',
          message: 'Video đang được tải lên hoặc đã lên YouTube, không đổi được',
        });
      await tx
        .update(youtubeUploads)
        .set({ ...patch(u), updatedAt: new Date() })
        .where(eq(youtubeUploads.id, id));
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action,
        targetType: 'youtube_upload',
        targetId: id,
        metadata: { from: u.status },
        ip: ctx.ip,
      });
    });
  }

  private async one(ctx: Ctx, id: string): Promise<YoutubeUploadResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const [r] = await tx
        .select({
          u: youtubeUploads,
          itemTitle: contentItems.title,
          ch: googleChannels,
          name: users.displayName,
        })
        .from(youtubeUploads)
        .innerJoin(contentItems, eq(contentItems.id, youtubeUploads.itemId))
        .innerJoin(googleChannels, eq(googleChannels.id, youtubeUploads.channelId))
        .leftJoin(users, eq(users.id, youtubeUploads.createdBy))
        .where(and(eq(youtubeUploads.id, id), eq(youtubeUploads.tenantId, ctx.tenantId)));
      if (!r)
        throw new NotFoundException({
          code: 'YOUTUBE_UPLOAD_NOT_FOUND',
          message: 'Không tìm thấy lượt tải lên',
        });
      return uploadResponse(r.u, r.itemTitle, r.ch, r.name);
    });
  }
}

function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function uploadResponse(
  u: UploadRow,
  itemTitle: string,
  ch: ChannelRow,
  name: string | null,
): YoutubeUploadResponse {
  const size = Number(u.stage.size ?? 0);
  const sent = Number(u.stage.sent ?? 0);
  return {
    id: u.id,
    itemId: u.itemId,
    itemTitle,
    version: u.version,
    channelId: ch.id,
    channelTitle: ch.title,
    format: u.format,
    title: u.title,
    privacy: u.privacy,
    publishAt: u.publishAt?.toISOString() ?? null,
    madeForKids: u.madeForKids,
    syntheticMedia: u.syntheticMedia,
    thumbnailItemId: u.thumbnailItemId,
    status: u.status,
    attempts: u.attempts,
    uploadedPct:
      u.status === 'uploading' && size > 0 ? Math.min(100, Math.round((sent / size) * 100)) : null,
    videoId: u.videoId,
    url: u.videoId ? youtubeUrl(u.videoId, u.format) : null,
    youtubePrivacy: u.youtubePrivacy,
    warnings: u.warnings,
    errorCode: u.errorCode,
    errorMessage: u.errorMessage,
    createdByName: name ?? '',
    createdAt: u.createdAt.toISOString(),
    publishedAt: u.publishedAt?.toISOString() ?? null,
  };
}
