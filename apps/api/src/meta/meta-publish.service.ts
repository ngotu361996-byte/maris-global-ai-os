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
import { join } from 'node:path';
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  META_LIMITS,
  META_MEDIA_MAX_MB,
  META_POST_FORMAT_LABEL,
  META_REEL_SECONDS,
  PLATFORM_LIMITS,
  type ListMetaPosts,
  type MetaPostFormat,
  type MetaPostResponse,
  type ScheduleMetaPost,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { qaReport } from '../content/content-qa';
import { DbService, type Tx } from '../db/db.service';
import { LocalFileStorage } from '../files/file-storage';
import { MetaError, MetaGraphService, type GraphRequest } from './meta-graph.service';

const { metaPosts, metaAssets, contentItems, contentItemVersions, users } = schema;
type PostRow = typeof metaPosts.$inferSelect;
type AssetRow = typeof metaAssets.$inferSelect;
type ItemRow = typeof contentItems.$inferSelect;
type VersionRow = typeof contentItemVersions.$inferSelect;

const TICK_MS = 30_000;
const CLAIM = 5;
/** How long one run may hold a post; a big video upload fits inside. */
const LOCK_MIN = 30;
const MAX_ATTEMPTS = 3;
/** Meta processes uploaded Reels; we look again this often, for at most this long. */
const PROCESS_POLL_SEC = 30;
const PROCESS_MAX_MIN = 30;
/** How long a post waits for the API budget or Meta's stop before it is given up. */
const MAX_DELAY_H = 24;
const MAX_AHEAD_DAYS = 90;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;
/** Graph error code for an Instagram container that is not ready yet. */
const IG_NOT_READY = 9007;

/** The day of an instant in a time zone, as YYYY-MM-DD. */
export function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** Which formats an item of this kind can go out as to this kind of account. */
export function formatFor(
  kind: ItemRow['kind'],
  mime: string | null,
  asset: AssetRow['kind'],
  videoAs: 'video' | 'reel',
): MetaPostFormat | null {
  const media = mime?.split('/')[0] ?? null;
  if (asset === 'page') {
    if (media === 'image') return 'photo';
    if (media === 'video') return videoAs;
    if (!mime && (kind === 'text' || kind === 'ad' || kind === 'other')) return 'feed';
    return null;
  }
  if (asset === 'instagram') {
    if (media === 'image') return 'ig_image';
    if (media === 'video') return 'ig_reel';
  }
  return null;
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

/**
 * Publishing approved content to Facebook Pages and Instagram (spec Part 14). Posts wait in
 * meta.posts; a publisher in this process claims due ones every 30 seconds and runs each as the
 * person who scheduled it, through the API Governor (group "publish", essential).
 *
 * A step that may already have reached Meta is never repeated blindly: when a write times out or
 * the process stops mid-way, the post is marked failed with "unknown" and waits for a person,
 * who checks the Page and retries or cancels. Answers that say for sure nothing was posted are
 * retried up to three times; stops from the Governor or Meta only move the post later.
 */
@Injectable()
export class MetaPublishService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MetaPublishService.name);
  private readonly storage: LocalFileStorage;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly graph: MetaGraphService,
    private readonly audit: AuditService,
  ) {
    this.storage = new LocalFileStorage(join(config.FILE_STORAGE_DIR, 'content'));
  }

  onModuleInit(): void {
    if (!this.config.META_PUBLISHER_ENABLED) return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.error(e)), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async schedule(ctx: Ctx, input: ScheduleMetaPost): Promise<MetaPostResponse[]> {
    const at = input.at ? new Date(input.at) : new Date();
    const now = Date.now();
    if (at.getTime() < now - 5 * 60_000)
      throw new BadRequestException({ code: 'META_POST_PAST', message: 'Thời điểm đăng đã qua' });
    if (at.getTime() > now + MAX_AHEAD_DAYS * 86400_000)
      throw new BadRequestException({
        code: 'META_POST_TOO_FAR',
        message: `Chỉ lên lịch trước tối đa ${MAX_AHEAD_DAYS} ngày`,
      });
    const day = localDay(at, this.config.META_TIMEZONE);

    const ids = await this.db.withContext(ctx, async (tx) => {
      // One tenant at a time, so the per-day limits hold when two people schedule together.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`meta-posts:${ctx.tenantId}`}))`,
      );
      const [item] = await tx
        .select()
        .from(contentItems)
        .where(and(eq(contentItems.id, input.itemId), eq(contentItems.tenantId, ctx.tenantId)));
      if (!item)
        throw new NotFoundException({
          code: 'CONTENT_ITEM_NOT_FOUND',
          message: 'Không tìm thấy thành phẩm',
        });
      if (item.status !== 'approved' && item.status !== 'published')
        throw new ConflictException({
          code: 'META_POST_NOT_APPROVED',
          message: 'Chỉ đăng được thành phẩm đã duyệt',
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
          code: 'META_POST_NO_VERSION',
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
          message: `Chưa đạt kiểm định: ${qa.checks.find((c) => c.level === 'error')?.message ?? ''}`,
        });

      const assets = await tx
        .select()
        .from(metaAssets)
        .where(and(eq(metaAssets.tenantId, ctx.tenantId), inArray(metaAssets.id, input.assetIds)));
      if (assets.length !== new Set(input.assetIds).size)
        throw new NotFoundException({
          code: 'META_ASSET_NOT_FOUND',
          message: 'Không tìm thấy Page hoặc tài khoản',
        });

      const planned: { asset: AssetRow; format: MetaPostFormat }[] = [];
      for (const a of assets) {
        if (!a.enabled || a.removedAt)
          throw new ConflictException({
            code: 'META_ASSET_OFF',
            message: `“${a.name}” chưa được bật trong Trung tâm Meta`,
          });
        const format = formatFor(item.kind, v.storageKey ? v.mime : null, a.kind, input.videoAs);
        if (!format)
          throw new BadRequestException({
            code: 'META_POST_FORMAT',
            message:
              a.kind === 'instagram'
                ? `Instagram chỉ nhận ảnh hoặc video; “${item.title}” không đăng lên @${a.username ?? a.name} được`
                : `“${item.title}” không đăng lên ${a.kind === 'page' ? 'Page' : 'tài khoản quảng cáo'} “${a.name}” được`,
          });
        this.checkMedia(format, v, input.caption, a);
        planned.push({ asset: a, format });
      }

      const counts = await tx
        .select({ assetId: metaPosts.assetId, n: sql<number>`count(*)::int` })
        .from(metaPosts)
        .where(
          and(
            eq(metaPosts.tenantId, ctx.tenantId),
            eq(metaPosts.localDay, day),
            inArray(metaPosts.status, ['scheduled', 'publishing', 'processing', 'published']),
          ),
        )
        .groupBy(metaPosts.assetId);
      const perAsset = new Map(counts.map((c) => [c.assetId, c.n]));
      const total = counts.reduce((a, c) => a + c.n, 0);
      if (total + planned.length > META_LIMITS.postsPerDay)
        throw new ConflictException({
          code: 'META_POST_LIMIT',
          message: `Ngày ${day} đã có ${total} bài; gói BUSINESS cho tối đa ${META_LIMITS.postsPerDay} bài mỗi ngày`,
        });
      for (const { asset } of planned)
        if ((perAsset.get(asset.id) ?? 0) >= META_LIMITS.postsPerPagePerDay)
          throw new ConflictException({
            code: 'META_POST_LIMIT',
            message: `“${asset.name}” đã có ${META_LIMITS.postsPerPagePerDay} bài ngày ${day}; tối đa ${META_LIMITS.postsPerPagePerDay} bài mỗi ngày cho mỗi Page hoặc tài khoản`,
          });

      const existing = await tx
        .select({ assetId: metaPosts.assetId, format: metaPosts.format, status: metaPosts.status })
        .from(metaPosts)
        .where(
          and(
            eq(metaPosts.tenantId, ctx.tenantId),
            eq(metaPosts.itemId, item.id),
            eq(metaPosts.version, v.version),
            sql`${metaPosts.status} <> 'cancelled'`,
          ),
        );
      const out: string[] = [];
      for (const { asset, format } of planned) {
        const dup = existing.find((e) => e.assetId === asset.id && e.format === format);
        if (dup)
          throw new ConflictException({
            code: 'META_POST_DUPLICATE',
            message: `Phiên bản ${v.version} đã ${dup.status === 'published' ? 'được đăng' : 'có trong lịch đăng'} lên “${asset.name}”`,
          });
        const id = uuidv7();
        await tx.insert(metaPosts).values({
          id,
          tenantId: ctx.tenantId,
          itemId: item.id,
          version: v.version,
          assetId: asset.id,
          format,
          caption: format === 'feed' ? null : input.caption,
          link: format === 'feed' ? input.link : null,
          scheduledAt: at,
          localDay: day,
          nextAttemptAt: at,
          createdBy: ctx.userId,
        });
        await this.audit.append(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'meta.post_scheduled',
          targetType: 'meta_post',
          targetId: id,
          metadata: {
            itemId: item.id,
            version: v.version,
            assetId: asset.id,
            format,
            at: at.toISOString(),
          },
          ip: ctx.ip,
        });
        out.push(id);
      }
      return out;
    });
    const all = await this.list(ctx, { itemId: input.itemId });
    return all.filter((p) => ids.includes(p.id));
  }

  async list(ctx: Ctx, filter: ListMetaPosts): Promise<MetaPostResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select({
          p: metaPosts,
          title: contentItems.title,
          asset: metaAssets,
          name: users.displayName,
        })
        .from(metaPosts)
        .innerJoin(contentItems, eq(contentItems.id, metaPosts.itemId))
        .innerJoin(metaAssets, eq(metaAssets.id, metaPosts.assetId))
        .leftJoin(users, eq(users.id, metaPosts.createdBy))
        .where(
          and(
            eq(metaPosts.tenantId, ctx.tenantId),
            filter.status ? eq(metaPosts.status, filter.status) : undefined,
            filter.itemId ? eq(metaPosts.itemId, filter.itemId) : undefined,
          ),
        )
        .orderBy(desc(metaPosts.scheduledAt), desc(metaPosts.id))
        .limit(200);
      return rows.map(({ p, title, asset, name }) => postResponse(p, title, asset, name));
    });
  }

  async cancel(ctx: Ctx, id: string): Promise<MetaPostResponse> {
    await this.change(ctx, id, ['scheduled', 'failed'], 'meta.post_cancelled', () => ({
      status: 'cancelled' as const,
    }));
    return this.one(ctx, id);
  }

  /** Puts a failed post back in the queue, now. Its row is reused, so it cannot go out twice. */
  async retry(ctx: Ctx, id: string): Promise<MetaPostResponse> {
    await this.change(ctx, id, ['failed'], 'meta.post_retried', (p) => ({
      status: 'scheduled' as const,
      attempts: 0,
      nextAttemptAt: new Date(),
      errorCode: null,
      errorMessage: null,
      // A step that surely reached Meta keeps its result; an unknown one starts over.
      stage: p.errorCode === 'META_POST_UNKNOWN' ? {} : p.stage,
    }));
    return this.one(ctx, id);
  }

  /** Claims due posts and runs them. Called every 30 seconds; tests call it directly. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      // A post still "publishing" after its lock ran out stopped half-way: its result is unknown.
      const stuck = await this.db.withSystem('meta_publisher', (tx) =>
        tx
          .select({
            id: metaPosts.id,
            tenantId: metaPosts.tenantId,
            createdBy: metaPosts.createdBy,
          })
          .from(metaPosts)
          .where(and(eq(metaPosts.status, 'publishing'), lte(metaPosts.lockedUntil, new Date())))
          .limit(50),
      );
      for (const s of stuck) await this.markUnknown(s);
      const claimed = await this.db.withSystem('meta_publisher', async (tx) => {
        const due = await tx.execute<{ id: string }>(sql`
          SELECT id FROM meta.posts
          WHERE status IN ('scheduled', 'processing') AND next_attempt_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY next_attempt_at
          LIMIT ${CLAIM}
          FOR UPDATE SKIP LOCKED`);
        const ids = [...due].map((r) => r.id);
        if (!ids.length) return [];
        return tx
          .update(metaPosts)
          .set({
            status: sql`CASE WHEN ${metaPosts.status} = 'scheduled' THEN 'publishing' ELSE ${metaPosts.status} END`,
            lockedUntil: new Date(Date.now() + LOCK_MIN * 60_000),
            updatedAt: new Date(),
          })
          .where(inArray(metaPosts.id, ids))
          .returning();
      });
      for (const p of claimed) await this.process(p);
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  /** Marks one post stopped half-way as failed with an unknown result, in its tenant. */
  private async markUnknown(s: { id: string; tenantId: string; createdBy: string }): Promise<void> {
    await this.db.withContext({ tenantId: s.tenantId, userId: s.createdBy }, async (tx) => {
      const [done] = await tx
        .update(metaPosts)
        .set({
          status: 'failed',
          lockedUntil: null,
          errorCode: 'META_POST_UNKNOWN',
          errorMessage:
            'MARIS dừng giữa lúc đăng; không rõ bài đã lên chưa. Kiểm tra trên Page rồi bấm Thử lại nếu chưa có.',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(metaPosts.id, s.id),
            eq(metaPosts.status, 'publishing'),
            lte(metaPosts.lockedUntil, new Date()),
          ),
        )
        .returning({ id: metaPosts.id });
      if (done)
        await this.audit.append(tx, {
          tenantId: s.tenantId,
          actorUserId: s.createdBy,
          action: 'meta.post_failed',
          targetType: 'meta_post',
          targetId: s.id,
          metadata: { code: 'META_POST_UNKNOWN' },
        });
    });
  }

  // ------------------------------------------------------------------------------ one post

  private async process(post: PostRow): Promise<void> {
    const ctx = { tenantId: post.tenantId, userId: post.createdBy };
    const stage = { ...post.stage };
    const save = (patch: Record<string, string | number | boolean>) => {
      Object.assign(stage, patch);
      return this.db.withContext(ctx, (tx) =>
        tx.update(metaPosts).set({ stage, updatedAt: new Date() }).where(eq(metaPosts.id, post.id)),
      );
    };
    try {
      const { item, version, asset, page } = await this.db.withContext(ctx, (tx) =>
        this.load(tx, post),
      );
      const result = await this.publish(ctx, post, stage, save, version, asset, page);
      if (result === 'processing') {
        await this.db.withContext(ctx, (tx) =>
          tx
            .update(metaPosts)
            .set({
              status: 'processing',
              lockedUntil: null,
              nextAttemptAt: new Date(Date.now() + PROCESS_POLL_SEC * 1000),
              updatedAt: new Date(),
            })
            .where(eq(metaPosts.id, post.id)),
        );
        return;
      }
      await this.db.withContext(ctx, async (tx) => {
        const now = new Date();
        await tx
          .update(metaPosts)
          .set({
            status: 'published',
            externalId: result.id,
            permalink: result.permalink,
            publishedAt: now,
            lockedUntil: null,
            errorCode: null,
            errorMessage: null,
            updatedAt: now,
          })
          .where(eq(metaPosts.id, post.id));
        await this.audit.append(tx, {
          tenantId: post.tenantId,
          actorUserId: post.createdBy,
          action: 'meta.post_published',
          targetType: 'meta_post',
          targetId: post.id,
          metadata: {
            itemId: post.itemId,
            version: post.version,
            format: post.format,
            externalId: result.id,
          },
        });
        // The first post of an approved item marks it published, with where it went.
        const [done] = await tx
          .update(contentItems)
          .set({
            status: 'published',
            publishedUrl: result.permalink,
            publishedAt: now,
            updatedAt: now,
          })
          .where(and(eq(contentItems.id, item.id), eq(contentItems.status, 'approved')))
          .returning({ id: contentItems.id });
        if (done)
          await this.audit.append(tx, {
            tenantId: post.tenantId,
            actorUserId: post.createdBy,
            action: 'content.item.published',
            targetType: 'content_item',
            targetId: item.id,
            metadata: { url: result.permalink, via: 'meta', postId: post.id },
          });
      });
    } catch (e) {
      await this.failed(post, e);
    }
  }

  private async failed(post: PostRow, e: unknown): Promise<void> {
    const ctx = { tenantId: post.tenantId, userId: post.createdBy };
    const code =
      e instanceof MetaError ? e.code : e instanceof Retry ? 'META_POST_RETRY' : 'META_POST_ERROR';
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    let retry: Retry | null = e instanceof Retry ? e : null;
    if (!retry && e instanceof MetaError) {
      // Stopped by the Governor or by Meta before anything was sent: try again later.
      if (e.getStatus() === 429)
        retry = new Retry(new Date(Date.now() + 15 * 60_000), false, message);
      // Meta answered with an error that is not about access: nothing was posted, try again.
      else if (e.code === 'META_GRAPH_ERROR' && post.attempts + 1 < MAX_ATTEMPTS)
        retry = new Retry(new Date(Date.now() + 5 * 60_000 * (post.attempts + 1)), true, message);
    }
    const tooLate = Date.now() - post.scheduledAt.getTime() > MAX_DELAY_H * 3600_000;
    // Network errors and time-outs on a write leave the result unknown: a person checks first.
    const unknown =
      e instanceof MetaError && e.code === 'META_NETWORK' && post.status !== 'processing';
    await this.db.withContext(ctx, async (tx) => {
      if (retry && !tooLate) {
        await tx
          .update(metaPosts)
          .set({
            status: post.status === 'processing' ? 'processing' : 'scheduled',
            attempts: post.attempts + (retry.countsAsAttempt ? 1 : 0),
            nextAttemptAt: retry.at,
            lockedUntil: null,
            errorCode: code,
            errorMessage: message,
            updatedAt: new Date(),
          })
          .where(eq(metaPosts.id, post.id));
        return;
      }
      const finalCode = unknown ? 'META_POST_UNKNOWN' : code;
      await tx
        .update(metaPosts)
        .set({
          status: 'failed',
          attempts: post.attempts + 1,
          lockedUntil: null,
          errorCode: finalCode,
          errorMessage: unknown
            ? `Không rõ bài đã lên chưa (${message}). Kiểm tra trên Page rồi bấm Thử lại nếu chưa có.`
            : tooLate
              ? `Quá ${MAX_DELAY_H} giờ so với lịch mà chưa đăng được: ${message}`
              : message,
          updatedAt: new Date(),
        })
        .where(eq(metaPosts.id, post.id));
      await this.audit.append(tx, {
        tenantId: post.tenantId,
        actorUserId: post.createdBy,
        action: 'meta.post_failed',
        targetType: 'meta_post',
        targetId: post.id,
        metadata: { code: finalCode, attempts: post.attempts + 1 },
      });
    });
  }

  private async publish(
    ctx: { tenantId: string; userId: string },
    post: PostRow,
    stage: Record<string, string | number | boolean>,
    save: (patch: Record<string, string | number | boolean>) => Promise<unknown>,
    v: VersionRow,
    asset: AssetRow,
    page: AssetRow,
  ): Promise<{ id: string; permalink: string | null } | 'processing'> {
    const call = <T>(req: Omit<GraphRequest, 'group' | 'priority' | 'auth' | 'assetId'>) =>
      this.graph.call<T>(ctx, {
        group: 'publish',
        priority: 'essential',
        auth: { kind: 'page', assetId: page.id },
        assetId: asset.id,
        ...req,
      });
    const file = () => {
      if (!v.storageKey || !v.mime)
        throw new MetaError(409, 'META_POST_NO_FILE', 'Phiên bản không có tệp');
      return {
        path: this.storage.filePath(v.storageKey),
        name: v.fileName ?? 'file',
        type: v.mime,
        size: v.sizeBytes ?? 0,
      };
    };
    const permalinkOf = async (id: string, field: 'permalink_url' | 'permalink') => {
      const r = await call<Record<string, string>>({
        method: 'GET',
        path: `/${id}`,
        params: { fields: field },
      }).catch(() => ({}) as Record<string, string>);
      const link = r[field] ?? null;
      return link?.startsWith('/') ? `https://www.facebook.com${link}` : link;
    };
    const P = page.externalId;
    const caption = post.caption ?? '';

    switch (post.format) {
      case 'feed': {
        const r = await call<{ id?: string }>({
          method: 'POST',
          path: `/${P}/feed`,
          params: { message: v.body ?? '', ...(post.link ? { link: post.link } : {}) },
        });
        if (!r.id) throw new MetaError(502, 'META_GRAPH_ERROR', 'Meta không trả về mã bài viết');
        return { id: r.id, permalink: await permalinkOf(r.id, 'permalink_url') };
      }
      case 'photo': {
        const f = file();
        const r = await call<{ id?: string; post_id?: string }>({
          method: 'POST',
          path: `/${P}/photos`,
          params: { caption, published: true },
          files: { source: f },
          timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        const id = r.post_id ?? r.id;
        if (!id) throw new MetaError(502, 'META_GRAPH_ERROR', 'Meta không trả về mã ảnh');
        return { id, permalink: await permalinkOf(id, 'permalink_url') };
      }
      case 'video': {
        const f = file();
        const r = await call<{ id?: string }>({
          host: 'video',
          method: 'POST',
          path: `/${P}/videos`,
          params: { description: caption },
          files: { source: f },
          timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        if (!r.id) throw new MetaError(502, 'META_GRAPH_ERROR', 'Meta không trả về mã video');
        return {
          id: r.id,
          permalink:
            (await permalinkOf(r.id, 'permalink_url')) ??
            `https://www.facebook.com/${P}/videos/${r.id}`,
        };
      }
      case 'reel': {
        const f = file();
        if (!stage.videoId) {
          const r = await call<{ video_id?: string }>({
            method: 'POST',
            path: `/${P}/video_reels`,
            params: { upload_phase: 'start' },
          });
          if (!r.video_id)
            throw new MetaError(502, 'META_GRAPH_ERROR', 'Meta không trả về mã Reels');
          await save({ videoId: r.video_id });
        }
        if (!stage.uploaded) {
          await call({
            host: 'upload',
            method: 'POST',
            path: `/video-upload/{v}/${String(stage.videoId)}`,
            upload: { path: f.path, size: f.size },
            timeoutMs: UPLOAD_TIMEOUT_MS,
          });
          await save({ uploaded: true });
        }
        await call({
          method: 'POST',
          path: `/${P}/video_reels`,
          params: {
            upload_phase: 'finish',
            video_id: String(stage.videoId),
            video_state: 'PUBLISHED',
            description: caption,
          },
        });
        return {
          id: String(stage.videoId),
          permalink: `https://www.facebook.com/reel/${String(stage.videoId)}`,
        };
      }
      case 'ig_image': {
        const IG = asset.externalId;
        if (!stage.containerId) {
          // Instagram takes images by address. The image goes to the Page first as an
          // unpublished photo, and Instagram reads it from Meta's own servers.
          if (!stage.imageUrl) {
            const f = file();
            const up = await call<{ id?: string }>({
              method: 'POST',
              path: `/${P}/photos`,
              params: { published: false, temporary: true },
              files: { source: f },
              timeoutMs: UPLOAD_TIMEOUT_MS,
            });
            if (!up.id) throw new MetaError(502, 'META_GRAPH_ERROR', 'Meta không trả về mã ảnh');
            const info = await call<{ images?: { source?: string; width?: number }[] }>({
              method: 'GET',
              path: `/${up.id}`,
              params: { fields: 'images' },
            });
            const best = [...(info.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]
              ?.source;
            if (!best)
              throw new MetaError(502, 'META_GRAPH_ERROR', 'Meta không trả về địa chỉ ảnh');
            await save({ imageUrl: best });
          }
          const c = await call<{ id?: string }>({
            method: 'POST',
            path: `/${IG}/media`,
            params: { image_url: String(stage.imageUrl), caption },
          });
          if (!c.id)
            throw new MetaError(502, 'META_GRAPH_ERROR', 'Instagram không trả về mã nội dung');
          await save({ containerId: c.id, since: Date.now() });
        }
        return this.igPublish(call, IG, stage, permalinkOf);
      }
      case 'ig_reel': {
        const IG = asset.externalId;
        if (!stage.containerId) {
          const c = await call<{ id?: string }>({
            method: 'POST',
            path: `/${IG}/media`,
            params: { media_type: 'REELS', upload_type: 'resumable', caption },
          });
          if (!c.id)
            throw new MetaError(502, 'META_GRAPH_ERROR', 'Instagram không trả về mã nội dung');
          await save({ containerId: c.id, since: Date.now() });
        }
        if (!stage.uploaded) {
          const f = file();
          await call({
            host: 'upload',
            method: 'POST',
            path: `/ig-api-upload/{v}/${String(stage.containerId)}`,
            upload: { path: f.path, size: f.size },
            timeoutMs: UPLOAD_TIMEOUT_MS,
          });
          await save({ uploaded: true });
          return 'processing';
        }
        const s = await call<{ status_code?: string; status?: string }>({
          method: 'GET',
          path: `/${String(stage.containerId)}`,
          params: { fields: 'status_code,status' },
        });
        if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED')
          throw new MetaError(
            502,
            'META_IG_PROCESSING',
            `Instagram không xử lý được video: ${s.status ?? s.status_code}`,
          );
        if (s.status_code !== 'FINISHED') return this.stillProcessing(stage);
        return this.igPublish(call, IG, stage, permalinkOf);
      }
    }
  }

  private stillProcessing(stage: Record<string, string | number | boolean>): 'processing' {
    if (Date.now() - Number(stage.since ?? Date.now()) > PROCESS_MAX_MIN * 60_000)
      throw new MetaError(502, 'META_IG_PROCESSING', `Instagram xử lý quá ${PROCESS_MAX_MIN} phút`);
    return 'processing';
  }

  private async igPublish(
    call: <T>(req: Omit<GraphRequest, 'group' | 'priority' | 'auth' | 'assetId'>) => Promise<T>,
    ig: string,
    stage: Record<string, string | number | boolean>,
    permalinkOf: (id: string, field: 'permalink') => Promise<string | null>,
  ): Promise<{ id: string; permalink: string | null } | 'processing'> {
    try {
      const r = await call<{ id?: string }>({
        method: 'POST',
        path: `/${ig}/media_publish`,
        params: { creation_id: String(stage.containerId) },
      });
      if (!r.id) throw new MetaError(502, 'META_GRAPH_ERROR', 'Instagram không trả về mã bài');
      return { id: r.id, permalink: await permalinkOf(r.id, 'permalink') };
    } catch (e) {
      if (e instanceof MetaError && e.graphCode === IG_NOT_READY)
        return this.stillProcessing(stage);
      throw e;
    }
  }

  private checkMedia(
    format: MetaPostFormat,
    v: VersionRow,
    caption: string | null,
    a: AssetRow,
  ): void {
    const mb = (v.sizeBytes ?? 0) / 1024 / 1024;
    const bad = (message: string) => new BadRequestException({ code: 'META_POST_MEDIA', message });
    if ((format === 'photo' || format === 'ig_image') && mb > META_MEDIA_MAX_MB.photo)
      throw bad(`Ảnh lớn hơn ${META_MEDIA_MAX_MB.photo} MB`);
    if (
      (format === 'video' || format === 'reel' || format === 'ig_reel') &&
      mb > META_MEDIA_MAX_MB.video
    )
      throw bad(`Video lớn hơn ${META_MEDIA_MAX_MB.video} MB`);
    if ((format === 'reel' || format === 'ig_reel') && v.durationMs !== null) {
      const { min, max } = META_REEL_SECONDS[format === 'reel' ? 'page' : 'instagram'];
      const sec = v.durationMs / 1000;
      if (sec < min || sec > max)
        throw bad(
          `${META_POST_FORMAT_LABEL[format]} cần dài từ ${min} đến ${max} giây; video này ${Math.round(sec)} giây${format === 'reel' ? '. Chọn đăng thành Video thường.' : ''}`,
        );
    }
    if (a.kind === 'instagram' && caption) {
      const lim = PLATFORM_LIMITS.instagram;
      const tags = caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
      if (lim.textMaxChars && [...caption].length > lim.textMaxChars)
        throw bad(`Chú thích Instagram tối đa ${lim.textMaxChars} ký tự`);
      if (lim.hashtagsMax && tags.length > lim.hashtagsMax)
        throw bad(`Chú thích Instagram tối đa ${lim.hashtagsMax} hashtag`);
    }
  }

  private async load(tx: Tx, post: PostRow) {
    const [item] = await tx.select().from(contentItems).where(eq(contentItems.id, post.itemId));
    const [version] = await tx
      .select()
      .from(contentItemVersions)
      .where(
        and(
          eq(contentItemVersions.itemId, post.itemId),
          eq(contentItemVersions.version, post.version),
        ),
      );
    const [asset] = await tx.select().from(metaAssets).where(eq(metaAssets.id, post.assetId));
    if (!item || !version || !asset)
      throw new MetaError(409, 'META_POST_GONE', 'Thành phẩm hoặc tài khoản không còn');
    if (item.status === 'archived')
      throw new MetaError(409, 'META_POST_ARCHIVED', 'Thành phẩm đã được lưu trữ, không đăng nữa');
    if (!asset.enabled || asset.removedAt)
      throw new MetaError(409, 'META_ASSET_OFF', `“${asset.name}” đã bị tắt trong Trung tâm Meta`);
    let page = asset;
    if (asset.kind === 'instagram') {
      const [p] = asset.pageId
        ? await tx
            .select()
            .from(metaAssets)
            .where(and(eq(metaAssets.id, asset.pageId), isNull(metaAssets.removedAt)))
        : [];
      if (!p)
        throw new MetaError(
          409,
          'META_ASSET_OFF',
          'Không còn Page gắn với tài khoản Instagram này',
        );
      page = p;
    }
    return { item, version, asset, page };
  }

  private async change(
    ctx: Ctx,
    id: string,
    from: PostRow['status'][],
    action: string,
    patch: (p: PostRow) => Partial<PostRow>,
  ): Promise<void> {
    await this.db.withContext(ctx, async (tx) => {
      const [p] = await tx
        .select()
        .from(metaPosts)
        .where(and(eq(metaPosts.id, id), eq(metaPosts.tenantId, ctx.tenantId)))
        .for('update');
      if (!p)
        throw new NotFoundException({ code: 'META_POST_NOT_FOUND', message: 'Không tìm thấy bài' });
      if (!from.includes(p.status))
        throw new ConflictException({
          code: 'META_POST_STATE',
          message: 'Bài đang được đăng hoặc đã đăng, không đổi được',
        });
      await tx
        .update(metaPosts)
        .set({ ...patch(p), updatedAt: new Date() })
        .where(eq(metaPosts.id, id));
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action,
        targetType: 'meta_post',
        targetId: id,
        metadata: { from: p.status },
        ip: ctx.ip,
      });
    });
  }

  private async one(ctx: Ctx, id: string): Promise<MetaPostResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const [r] = await tx
        .select({
          p: metaPosts,
          title: contentItems.title,
          asset: metaAssets,
          name: users.displayName,
        })
        .from(metaPosts)
        .innerJoin(contentItems, eq(contentItems.id, metaPosts.itemId))
        .innerJoin(metaAssets, eq(metaAssets.id, metaPosts.assetId))
        .leftJoin(users, eq(users.id, metaPosts.createdBy))
        .where(and(eq(metaPosts.id, id), or(eq(metaPosts.tenantId, ctx.tenantId))));
      if (!r)
        throw new NotFoundException({ code: 'META_POST_NOT_FOUND', message: 'Không tìm thấy bài' });
      return postResponse(r.p, r.title, r.asset, r.name);
    });
  }
}

function postResponse(
  p: PostRow,
  title: string,
  a: AssetRow,
  name: string | null,
): MetaPostResponse {
  return {
    id: p.id,
    itemId: p.itemId,
    itemTitle: title,
    version: p.version,
    assetId: a.id,
    assetName: a.kind === 'instagram' && a.username ? `@${a.username}` : a.name,
    assetKind: a.kind,
    format: p.format,
    caption: p.caption,
    link: p.link,
    scheduledAt: p.scheduledAt.toISOString(),
    localDay: String(p.localDay),
    status: p.status,
    attempts: p.attempts,
    nextAttemptAt:
      p.status === 'scheduled' || p.status === 'processing' ? p.nextAttemptAt.toISOString() : null,
    externalId: p.externalId,
    permalink: p.permalink,
    errorCode: p.errorCode,
    errorMessage: p.errorMessage,
    createdByName: name ?? '',
    createdAt: p.createdAt.toISOString(),
    publishedAt: p.publishedAt?.toISOString() ?? null,
  };
}
