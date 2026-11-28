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
import { and, desc, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  TIKTOK_LIMITS,
  TIKTOK_RULES,
  type ListTiktokPosts,
  type ScheduleTiktok,
  type TiktokCreatorResponse,
  type TiktokPostResponse,
  type TiktokPrivacy,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { qaReport } from '../content/content-qa';
import { DbService, type Tx } from '../db/db.service';
import { LocalFileStorage } from '../files/file-storage';
import { SecretVaultService } from '../secrets/secret-vault.service';
import {
  chunkPlan,
  chunkRange,
  interactionWarnings,
  postProblems,
  tiktokUrl,
} from './rules';
import { TiktokApiService, TiktokError } from './tiktok-api.service';
import { TiktokService } from './tiktok.service';

const { tiktokPosts, tiktokAccounts, tiktokApps, contentItems, contentItemVersions, users } =
  schema;
type PostRow = typeof tiktokPosts.$inferSelect;
type AccountRow = typeof tiktokAccounts.$inferSelect;
type Stage = Record<string, string | number | boolean>;

const TICK_MS = 30_000;
const CLAIM = 2;
/** How long one run may hold a post; a big video fits inside. */
const LOCK_MIN = 90;
const CHUNK_TIMEOUT_MS = 20 * 60_000;
const MAX_ATTEMPTS = 5;
/** TikTok processes an uploaded video; MARIS asks again this often, for at most this long. */
const STATUS_POLL_SEC = 30;
const PROCESS_MAX_MIN = 60;
/** A post that cannot go out within this long after its time is given up. */
const MAX_DELAY_H = 24;
const UPLOAD_SCOPE = 'tiktok-upload';

class Retry extends Error {
  constructor(
    readonly at: Date,
    readonly countsAsAttempt: boolean,
    message: string,
  ) {
    super(message);
  }
}

/** TikTok's reasons for a failed post, in words a person can act on. */
const FAIL_REASONS: Record<string, string> = {
  file_format_check_failed: 'TikTok không đọc được định dạng video (nên dùng MP4, H.264)',
  duration_check_failed: 'Độ dài video không hợp với TikTok',
  frame_rate_check_failed: 'Tốc độ khung hình không hợp với TikTok (23 đến 60 hình mỗi giây)',
  picture_size_check_failed: 'Kích thước khung hình không hợp với TikTok (360 đến 4096 điểm ảnh)',
  internal: 'TikTok gặp lỗi nội bộ',
  video_pull_failed: 'TikTok không lấy được video',
  publish_cancelled: 'Bài đăng đã bị hủy trên TikTok',
  auth_removed: 'Người dùng đã gỡ quyền của ứng dụng trên TikTok',
  spam_risk_too_many_posts: 'Tài khoản đã đăng quá số bài TikTok cho phép trong ngày',
  spam_risk_user_banned_from_posting: 'TikTok đang chặn tài khoản này đăng bài',
  spam_risk_text: 'TikTok cho rằng chú thích có dấu hiệu spam',
  spam_risk: 'TikTok cho rằng bài đăng có dấu hiệu spam',
};

/** The upload address must be TikTok's own (or, in tests, the API host). */
function trustedUploadUrl(url: string, apiBase: string): boolean {
  try {
    const u = new URL(url);
    if (u.origin === new URL(apiBase).origin) return true;
    return u.protocol === 'https:' && /(^|\.)tiktokapis\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Posting approved videos to TikTok (spec Part 17). Posts wait in tiktok.posts; a publisher in this
 * process claims due ones every 30 seconds and runs each as the person who asked, through the
 * TikTok gateway.
 *
 * Before a Direct Post MARIS asks TikTok again what the creator may post. The file goes up in
 * pieces; the pieces sent are kept, so a post cut off by a network error or a restart goes on
 * from the next piece, and a post that TikTok has not got in full never appears. TikTok has no
 * scheduled posting, so a post set for later waits here until its time (the computer running
 * MARIS must be on then).
 */
@Injectable()
export class TiktokPublishService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TiktokPublishService.name);
  private readonly storage: LocalFileStorage;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly api: TiktokApiService,
    private readonly tiktok: TiktokService,
    private readonly vault: SecretVaultService,
    private readonly audit: AuditService,
  ) {
    this.storage = new LocalFileStorage(join(config.FILE_STORAGE_DIR, 'content'));
  }

  onModuleInit(): void {
    if (!this.config.TIKTOK_PUBLISHER_ENABLED) return;
    this.timer = setInterval(() => void this.runOnce().catch((e) => this.log.error(e)), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async schedule(ctx: Ctx, input: ScheduleTiktok): Promise<TiktokPostResponse[]> {
    const now = Date.now();
    let at = input.at ? new Date(input.at) : new Date(now);
    if (at.getTime() < now - 5 * 60_000)
      throw new BadRequestException({ code: 'TIKTOK_PAST', message: 'Thời điểm đăng đã qua' });
    if (at.getTime() < now) at = new Date(now);
    if (at.getTime() > now + TIKTOK_RULES.maxAheadDays * 86_400_000)
      throw new BadRequestException({
        code: 'TIKTOK_TOO_FAR',
        message: `Chỉ hẹn giờ trước tối đa ${TIKTOK_RULES.maxAheadDays} ngày`,
      });
    const scope = input.mode === 'direct' ? 'video.publish' : 'video.upload';

    const ids = await this.db.withContext(ctx, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tiktok-posts:${ctx.tenantId}`}))`);
      const [app] = await tx.select().from(tiktokApps).where(eq(tiktokApps.tenantId, ctx.tenantId));
      if (!app)
        throw new ConflictException({
          code: 'TIKTOK_APP_MISSING',
          message: 'Chưa cài ứng dụng TikTok trong Trung tâm TikTok',
        });
      const { item, v } = await this.approvedVersion(tx, ctx.tenantId, input.itemId);
      if (!v.storageKey || !v.mime?.startsWith('video/'))
        throw new BadRequestException({
          code: 'TIKTOK_NOT_VIDEO',
          message: 'TikTok chỉ nhận video; thành phẩm này không phải video',
        });
      if (!(TIKTOK_RULES.mimes as readonly string[]).includes(v.mime))
        throw new BadRequestException({
          code: 'TIKTOK_MEDIA',
          message: 'TikTok nhận video MP4, MOV hoặc WebM',
        });
      if ((v.sizeBytes ?? 0) > TIKTOK_RULES.videoMaxMb * 1024 * 1024)
        throw new BadRequestException({
          code: 'TIKTOK_MEDIA',
          message: `Video lớn hơn ${TIKTOK_RULES.videoMaxMb / 1024} GB`,
        });

      const accounts = await tx
        .select()
        .from(tiktokAccounts)
        .where(
          and(
            eq(tiktokAccounts.tenantId, ctx.tenantId),
            inArray(tiktokAccounts.id, input.accountIds),
          ),
        );
      if (accounts.length !== new Set(input.accountIds).size)
        throw new NotFoundException({
          code: 'TIKTOK_ACCOUNT_NOT_FOUND',
          message: 'Không tìm thấy tài khoản TikTok',
        });
      for (const a of accounts) {
        if (a.status !== 'active')
          throw new ConflictException({
            code: 'TIKTOK_NOT_CONNECTED',
            message: `Tài khoản TikTok “${a.displayName}” cần kết nối lại`,
          });
        if (!a.enabled)
          throw new ConflictException({
            code: 'TIKTOK_ACCOUNT_OFF',
            message: `Tài khoản “${a.displayName}” đang tắt trong Trung tâm TikTok`,
          });
        if (!a.scopes.includes(scope))
          throw new ConflictException({
            code: 'TIKTOK_PERMISSION',
            message: `Tài khoản “${a.displayName}” chưa cho MARIS quyền ${input.mode === 'direct' ? 'đăng thẳng' : 'gửi vào hộp nháp'}. Bấm Kết nối TikTok và đánh dấu quyền đó.`,
          });
        const problems = postProblems(
          { ...input, durationMs: v.durationMs, audited: app.audited },
          input.mode === 'direct' ? (a.creator as TiktokCreatorResponse | null) : null,
        );
        if (problems.length)
          throw new BadRequestException({
            code: 'TIKTOK_POLICY',
            message: `${a.displayName}: ${problems.join('. ')}`,
          });
        const busy = await this.postsInDay(tx, ctx.tenantId, a.id);
        if (busy >= TIKTOK_LIMITS.postsPerDay)
          throw new ConflictException({
            code: 'TIKTOK_POST_LIMIT',
            message: `“${a.displayName}” đã có ${busy} bài đăng hoặc đang chờ trong 24 giờ; MARIS dừng ở ${TIKTOK_LIMITS.postsPerDay} bài để TikTok không chặn tài khoản`,
          });
      }

      const existing = await tx
        .select({ accountId: tiktokPosts.accountId, status: tiktokPosts.status })
        .from(tiktokPosts)
        .where(
          and(
            eq(tiktokPosts.tenantId, ctx.tenantId),
            eq(tiktokPosts.itemId, item.id),
            eq(tiktokPosts.version, v.version),
            sql`${tiktokPosts.status} <> 'cancelled'`,
          ),
        );
      const out: string[] = [];
      for (const a of accounts) {
        const dup = existing.find((e) => e.accountId === a.id);
        if (dup)
          throw new ConflictException({
            code: 'TIKTOK_DUPLICATE',
            message: `Phiên bản ${v.version} đã ${dup.status === 'published' || dup.status === 'in_inbox' ? 'được gửi tới' : 'đang chờ đăng lên'} “${a.displayName}”`,
          });
        const id = uuidv7();
        const warnings =
          input.mode === 'direct'
            ? interactionWarnings(input, a.creator as TiktokCreatorResponse | null)
            : [];
        await tx.insert(tiktokPosts).values({
          id,
          tenantId: ctx.tenantId,
          itemId: item.id,
          version: v.version,
          accountId: a.id,
          mode: input.mode,
          title: input.mode === 'direct' ? input.title : '',
          privacy: input.mode === 'direct' ? input.privacy : null,
          allowComment: input.allowComment,
          allowDuet: input.allowDuet,
          allowStitch: input.allowStitch,
          brandOrganic: input.brandOrganic,
          brandedContent: input.brandedContent,
          aigc: input.aigc,
          coverMs: input.coverMs,
          scheduledAt: at,
          nextAttemptAt: at,
          warnings,
          createdBy: ctx.userId,
        });
        await this.audit.append(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'tiktok.post_scheduled',
          targetType: 'tiktok_post',
          targetId: id,
          metadata: {
            itemId: item.id,
            version: v.version,
            accountId: a.id,
            mode: input.mode,
            privacy: input.privacy,
            scheduledAt: at.toISOString(),
            brandOrganic: input.brandOrganic,
            brandedContent: input.brandedContent,
            aigc: input.aigc,
            musicConsent: input.consent,
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

  async list(ctx: Ctx, filter: ListTiktokPosts): Promise<TiktokPostResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select({
          p: tiktokPosts,
          itemTitle: contentItems.title,
          a: tiktokAccounts,
          name: users.displayName,
        })
        .from(tiktokPosts)
        .innerJoin(contentItems, eq(contentItems.id, tiktokPosts.itemId))
        .innerJoin(tiktokAccounts, eq(tiktokAccounts.id, tiktokPosts.accountId))
        .leftJoin(users, eq(users.id, tiktokPosts.createdBy))
        .where(
          and(
            eq(tiktokPosts.tenantId, ctx.tenantId),
            filter.status ? eq(tiktokPosts.status, filter.status) : undefined,
            filter.itemId ? eq(tiktokPosts.itemId, filter.itemId) : undefined,
          ),
        )
        .orderBy(desc(tiktokPosts.createdAt), desc(tiktokPosts.id))
        .limit(200);
      return rows.map(({ p, itemTitle, a, name }) => postResponse(p, itemTitle, a, name));
    });
  }

  async cancel(ctx: Ctx, id: string): Promise<TiktokPostResponse> {
    await this.change(ctx, id, ['scheduled', 'failed'], 'tiktok.post_cancelled', (p) => {
      // Once TikTok has the whole file the post goes on there; cancelling cannot stop it.
      if (p.stage.publishId && Number(p.stage.next ?? 0) >= Number(p.stage.count ?? 1))
        throw new ConflictException({
          code: 'TIKTOK_STATE',
          message: 'TikTok đã nhận đủ video; xem hoặc xóa bài trong app TikTok',
        });
      return { status: 'cancelled' as const };
    });
    return this.one(ctx, id);
  }

  /** Puts a failed post back in the queue. What TikTok already has is reused. */
  async retry(ctx: Ctx, id: string): Promise<TiktokPostResponse> {
    await this.change(ctx, id, ['failed'], 'tiktok.post_retried', (p) => ({
      status:
        p.stage.publishId && Number(p.stage.next ?? 0) >= Number(p.stage.count ?? 1)
          ? ('processing' as const)
          : ('scheduled' as const),
      attempts: 0,
      nextAttemptAt: new Date(),
      // A late post that is retried by hand goes out now.
      scheduledAt: p.scheduledAt.getTime() < Date.now() ? new Date() : p.scheduledAt,
      errorCode: null,
      errorMessage: null,
    }));
    return this.one(ctx, id);
  }

  /** Claims due posts and runs them. Called every 30 seconds; tests call it directly. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const claimed = await this.db.withSystem('tiktok_publisher', async (tx) => {
        const due = await tx.execute<{ id: string }>(sql`
          SELECT id FROM tiktok.posts
          WHERE status IN ('scheduled', 'uploading', 'processing') AND next_attempt_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY next_attempt_at
          LIMIT ${CLAIM}
          FOR UPDATE SKIP LOCKED`);
        const ids = [...due].map((r) => r.id);
        if (!ids.length) return [];
        return tx
          .update(tiktokPosts)
          .set({
            status: sql`CASE WHEN ${tiktokPosts.status} = 'scheduled' THEN 'uploading' ELSE ${tiktokPosts.status} END`,
            lockedUntil: new Date(Date.now() + LOCK_MIN * 60_000),
            updatedAt: new Date(),
          })
          .where(inArray(tiktokPosts.id, ids))
          .returning();
      });
      for (const p of claimed) await this.process(p);
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  // ------------------------------------------------------------------------------- one post

  private async process(p: PostRow): Promise<void> {
    const ctx = { tenantId: p.tenantId, userId: p.createdBy };
    const stage: Stage = { ...p.stage };
    const warnings = [...p.warnings];
    const save = (patch: Stage, extra: Partial<PostRow> = {}) => {
      Object.assign(stage, patch);
      return this.db.withContext(ctx, (tx) =>
        tx
          .update(tiktokPosts)
          .set({ stage, warnings, updatedAt: new Date(), ...extra })
          .where(eq(tiktokPosts.id, p.id)),
      );
    };
    try {
      if (Date.now() - p.scheduledAt.getTime() > MAX_DELAY_H * 3600_000 && !stage.publishId)
        throw new TiktokError(
          409,
          'TIKTOK_TOO_LATE',
          `Đã quá ${MAX_DELAY_H} giờ sau giờ hẹn mà chưa đăng được (máy chạy MARIS tắt hoặc TikTok từ chối); bấm Thử lại để đăng ngay`,
        );
      const { v, account, audited } = await this.db.withContext(ctx, (tx) => this.load(tx, p));
      const auth = { kind: 'account' as const, accountId: account.id };

      if (!stage.publishId) {
        const busy = await this.db.withContext(ctx, (tx) =>
          this.postsInDay(tx, p.tenantId, account.id, p.id),
        );
        if (busy >= TIKTOK_LIMITS.postsPerDay)
          throw new Retry(
            new Date(Date.now() + 3600_000),
            false,
            `Tài khoản đã có ${busy} bài trong 24 giờ; MARIS chờ để TikTok không chặn tài khoản`,
          );
        const file = await openAsBlob(this.storage.filePath(v.storageKey!), { type: v.mime! });
        const plan = chunkPlan(file.size);
        const source = {
          source: 'FILE_UPLOAD',
          video_size: file.size,
          chunk_size: plan.chunkSize,
          total_chunk_count: plan.count,
        };
        let json: unknown;
        if (p.mode === 'direct') {
          // TikTok's guidelines: ask again what the creator may post, just before posting.
          const creator = await this.tiktok.creatorInfo(ctx, account.id);
          const problems = postProblems(
            {
              mode: 'direct',
              privacy: p.privacy,
              allowComment: p.allowComment,
              allowDuet: p.allowDuet,
              allowStitch: p.allowStitch,
              brandedContent: p.brandedContent,
              durationMs: v.durationMs,
              audited,
            },
            creator,
          );
          if (problems.length) throw new TiktokError(409, 'TIKTOK_POLICY', problems.join('. '));
          for (const w of interactionWarnings(p, creator)) if (!warnings.includes(w)) warnings.push(w);
          json = {
            post_info: {
              title: p.title,
              privacy_level: p.privacy,
              disable_comment: !p.allowComment || creator.commentDisabled,
              disable_duet: !p.allowDuet || creator.duetDisabled,
              disable_stitch: !p.allowStitch || creator.stitchDisabled,
              video_cover_timestamp_ms: p.coverMs,
              brand_content_toggle: p.brandedContent,
              brand_organic_toggle: p.brandOrganic,
              is_aigc: p.aigc,
            },
            source_info: source,
          };
        } else json = { source_info: source };
        const r = await this.api.call<{ data?: { publish_id?: string; upload_url?: string } }>(
          ctx,
          {
            group: 'post',
            method: 'POST',
            path:
              p.mode === 'direct'
                ? '/v2/post/publish/video/init/'
                : '/v2/post/publish/inbox/video/init/',
            json,
            auth,
          },
        );
        const publishId = r.body.data?.publish_id;
        const uploadUrl = r.body.data?.upload_url;
        if (!publishId || publishId.length > 200 || !uploadUrl)
          throw new TiktokError(502, 'TIKTOK_API_ERROR', 'TikTok không trả về mã bài đăng');
        if (!trustedUploadUrl(uploadUrl, this.config.TIKTOK_API_URL))
          throw new TiktokError(502, 'TIKTOK_API_ERROR', 'TikTok trả về địa chỉ tải lên lạ');
        await save(
          {
            publishId,
            upload: this.vault.sealFor(UPLOAD_SCOPE, p.tenantId, p.id, uploadUrl),
            size: file.size,
            chunkSize: plan.chunkSize,
            count: plan.count,
            next: 0,
          },
          { publishId },
        );
      }

      if (Number(stage.next) < Number(stage.count)) {
        await this.upload(p, stage, save, v.storageKey!, v.mime!, account.id);
        await save({ since: Date.now() }, { status: 'processing' });
      }

      const s = await this.api.call<{
        data?: {
          status?: string;
          fail_reason?: string;
          publicaly_available_post_id?: (string | number)[];
          publicly_available_post_id?: (string | number)[];
        };
      }>(ctx, {
        group: 'post',
        method: 'POST',
        path: '/v2/post/publish/status/fetch/',
        json: { publish_id: String(stage.publishId) },
        auth,
      });
      const d = s.body.data ?? {};
      if (d.status === 'FAILED') {
        const reason = d.fail_reason ?? '';
        throw new TiktokError(
          502,
          'TIKTOK_FAILED',
          `TikTok không đăng được: ${FAIL_REASONS[reason] ?? (reason || 'không rõ lý do')}`,
        );
      }
      if (d.status === 'PUBLISH_COMPLETE' || d.status === 'SEND_TO_USER_INBOX') {
        const ids = d.publicaly_available_post_id ?? d.publicly_available_post_id ?? [];
        const postId = ids.map(String).find((x) => /^[0-9]{1,30}$/.test(x)) ?? null;
        if (d.status === 'SEND_TO_USER_INBOX')
          warnings.push('Video đã vào hộp thư TikTok: mở app TikTok để viết chú thích và đăng');
        else if (!postId)
          warnings.push(
            p.privacy === 'SELF_ONLY'
              ? 'Video đăng ở chế độ Chỉ mình tôi; mở app TikTok để đổi chế độ xem'
              : 'TikTok chưa cho đường dẫn công khai (video có thể đang được kiểm duyệt); xem trong app TikTok',
          );
        await this.done(
          p,
          account,
          d.status === 'SEND_TO_USER_INBOX' ? 'in_inbox' : 'published',
          String(stage.publishId),
          postId,
          warnings,
        );
        return;
      }
      if (Date.now() - Number(stage.since ?? Date.now()) > PROCESS_MAX_MIN * 60_000)
        throw new TiktokError(
          504,
          'TIKTOK_TIMEOUT',
          `TikTok chưa báo xong sau ${PROCESS_MAX_MIN} phút; xem trong app TikTok, hoặc bấm Thử lại để hỏi lại`,
        );
      await this.db.withContext(ctx, (tx) =>
        tx
          .update(tiktokPosts)
          .set({
            status: 'processing',
            lockedUntil: null,
            warnings,
            nextAttemptAt: new Date(Date.now() + STATUS_POLL_SEC * 1000),
            updatedAt: new Date(),
          })
          .where(eq(tiktokPosts.id, p.id)),
      );
    } catch (e) {
      await this.failed(p, e, stage, warnings);
    }
  }

  /** Sends the pieces TikTok does not have yet, keeping count after each one. */
  private async upload(
    p: PostRow,
    stage: Stage,
    save: (patch: Stage) => Promise<unknown>,
    storageKey: string,
    mime: string,
    accountId: string,
  ): Promise<void> {
    const ctx = { tenantId: p.tenantId, userId: p.createdBy };
    const file = await openAsBlob(this.storage.filePath(storageKey), { type: mime });
    const size = Number(stage.size);
    if (file.size !== size)
      throw new TiktokError(409, 'TIKTOK_FILE_CHANGED', 'Tệp video đã thay đổi giữa chừng');
    const plan = { chunkSize: Number(stage.chunkSize), count: Number(stage.count) };
    const url = this.vault.openFor(UPLOAD_SCOPE, p.tenantId, p.id, String(stage.upload));
    for (let i = Number(stage.next); i < plan.count; i++) {
      const { from, to } = chunkRange(size, plan, i);
      try {
        await this.api.call(ctx, {
          group: 'upload',
          method: 'PUT',
          uploadUrl: url,
          headers: {
            'Content-Type': mime,
            'Content-Range': `bytes ${from}-${to - 1}/${size}`,
          },
          body: file.slice(from, to),
          auth: { kind: 'none' },
          accountId,
          timeoutMs: CHUNK_TIMEOUT_MS,
        });
      } catch (e) {
        // The upload address lasts an hour. When TikTok refuses it, start again with a new one,
        // unless TikTok already has the whole video (the last piece arrived but was not counted).
        if (e instanceof TiktokError && e.kind !== 'network' && e.kind !== 'transient' && e.getStatus() !== 429) {
          const st = await this.api
            .call<{ data?: { status?: string } }>(ctx, {
              group: 'post',
              method: 'POST',
              path: '/v2/post/publish/status/fetch/',
              json: { publish_id: String(stage.publishId) },
              auth: { kind: 'account', accountId },
            })
            .catch(() => null);
          const s = st?.body.data?.status;
          if (s && s !== 'PROCESSING_UPLOAD' && s !== 'FAILED') {
            await save({ next: plan.count });
            return;
          }
          for (const k of ['publishId', 'upload', 'size', 'chunkSize', 'count', 'next'])
            delete stage[k];
          await save({});
          throw new Retry(
            new Date(Date.now() + 60_000),
            true,
            `TikTok không nhận phần video (${e.message}); MARIS tải lại từ đầu`,
          );
        }
        throw e;
      }
      await save({ next: i + 1 });
    }
  }

  private async done(
    p: PostRow,
    account: AccountRow,
    status: 'published' | 'in_inbox',
    publishId: string,
    postId: string | null,
    warnings: string[],
  ): Promise<void> {
    const ctx = { tenantId: p.tenantId, userId: p.createdBy };
    const url = postId ? tiktokUrl(account.username, postId) : null;
    await this.db.withContext(ctx, async (tx) => {
      const now = new Date();
      await tx
        .update(tiktokPosts)
        .set({
          status,
          publishId,
          postId,
          warnings,
          publishedAt: now,
          lockedUntil: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(tiktokPosts.id, p.id));
      await this.audit.append(tx, {
        tenantId: p.tenantId,
        actorUserId: p.createdBy,
        action: status === 'published' ? 'tiktok.post_published' : 'tiktok.post_in_inbox',
        targetType: 'tiktok_post',
        targetId: p.id,
        metadata: { itemId: p.itemId, version: p.version, publishId, postId },
      });
      // The first public post of an approved item marks it published, with where it went.
      if (url) {
        const [marked] = await tx
          .update(contentItems)
          .set({ status: 'published', publishedUrl: url, publishedAt: now, updatedAt: now })
          .where(and(eq(contentItems.id, p.itemId), eq(contentItems.status, 'approved')))
          .returning({ id: contentItems.id });
        if (marked)
          await this.audit.append(tx, {
            tenantId: p.tenantId,
            actorUserId: p.createdBy,
            action: 'content.item.published',
            targetType: 'content_item',
            targetId: p.itemId,
            metadata: { url, via: 'tiktok', postId: p.id },
          });
      }
    });
  }

  private async failed(p: PostRow, e: unknown, stage: Stage, warnings: string[]): Promise<void> {
    const ctx = { tenantId: p.tenantId, userId: p.createdBy };
    const code =
      e instanceof TiktokError ? e.code : e instanceof Retry ? 'TIKTOK_RETRY' : 'TIKTOK_ERROR';
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    let retry: Retry | null = e instanceof Retry ? e : null;
    if (!retry && e instanceof TiktokError) {
      // Stopped by TikTok's limits before anything was done: try again later.
      if (e.getStatus() === 429)
        retry = new Retry(e.retryAt ?? new Date(Date.now() + 15 * 60_000), false, message);
      // A cut connection or a passing error: the pieces sent are kept.
      else if ((e.kind === 'network' || e.kind === 'transient') && p.attempts + 1 < MAX_ATTEMPTS)
        retry = new Retry(new Date(Date.now() + 2 * 60_000 * (p.attempts + 1)), true, message);
    }
    if (retry && retry.countsAsAttempt && p.attempts + 1 >= MAX_ATTEMPTS) retry = null;
    // TikTok gave the post up: a retry starts a new one.
    if (code === 'TIKTOK_FAILED')
      for (const k of ['publishId', 'upload', 'size', 'chunkSize', 'count', 'next', 'since'])
        delete stage[k];
    const uploaded = Boolean(stage.publishId) && Number(stage.next) >= Number(stage.count);
    await this.db.withContext(ctx, async (tx) => {
      if (retry) {
        await tx
          .update(tiktokPosts)
          .set({
            status: uploaded ? 'processing' : stage.publishId ? 'uploading' : 'scheduled',
            attempts: p.attempts + (retry.countsAsAttempt ? 1 : 0),
            nextAttemptAt: retry.at,
            lockedUntil: null,
            stage,
            warnings,
            errorCode: code,
            errorMessage: message,
            updatedAt: new Date(),
          })
          .where(eq(tiktokPosts.id, p.id));
        return;
      }
      await tx
        .update(tiktokPosts)
        .set({
          status: 'failed',
          attempts: p.attempts + 1,
          lockedUntil: null,
          stage,
          warnings,
          errorCode: code,
          errorMessage: message,
          updatedAt: new Date(),
        })
        .where(eq(tiktokPosts.id, p.id));
      await this.audit.append(tx, {
        tenantId: p.tenantId,
        actorUserId: p.createdBy,
        action: 'tiktok.post_failed',
        targetType: 'tiktok_post',
        targetId: p.id,
        metadata: { code, attempts: p.attempts + 1 },
      });
    });
  }

  /** Posts of an account sent or under way in the last 24 hours, and ones due in the next 24. */
  private async postsInDay(
    tx: Tx,
    tenantId: string,
    accountId: string,
    except?: string,
  ): Promise<number> {
    const now = Date.now();
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(tiktokPosts)
      .where(
        and(
          eq(tiktokPosts.tenantId, tenantId),
          eq(tiktokPosts.accountId, accountId),
          except ? ne(tiktokPosts.id, except) : undefined,
          or(
            inArray(tiktokPosts.status, ['uploading', 'processing']),
            and(
              eq(tiktokPosts.status, 'scheduled'),
              lt(tiktokPosts.scheduledAt, new Date(now + 86_400_000)),
            ),
            gte(tiktokPosts.publishedAt, new Date(now - 86_400_000)),
          ),
        ),
      );
    return n;
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
        code: 'TIKTOK_NOT_APPROVED',
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
        code: 'TIKTOK_NO_VERSION',
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

  private async load(tx: Tx, p: PostRow) {
    const [item] = await tx.select().from(contentItems).where(eq(contentItems.id, p.itemId));
    const [v] = await tx
      .select()
      .from(contentItemVersions)
      .where(
        and(eq(contentItemVersions.itemId, p.itemId), eq(contentItemVersions.version, p.version)),
      );
    const [account] = await tx
      .select()
      .from(tiktokAccounts)
      .where(eq(tiktokAccounts.id, p.accountId));
    const [app] = await tx.select().from(tiktokApps).where(eq(tiktokApps.tenantId, p.tenantId));
    if (!item || !v?.storageKey || !account)
      throw new TiktokError(409, 'TIKTOK_GONE', 'Thành phẩm hoặc tài khoản không còn');
    const started = Boolean(p.stage.publishId);
    if (item.status === 'archived' && !started)
      throw new TiktokError(409, 'TIKTOK_ARCHIVED', 'Thành phẩm đã được lưu trữ, không đăng nữa');
    if (account.status === 'removed' || (!account.enabled && !started))
      throw new TiktokError(
        409,
        'TIKTOK_ACCOUNT_OFF',
        `Tài khoản “${account.displayName}” đã bị tắt hoặc ngắt trong Trung tâm TikTok`,
      );
    return { v, account, audited: app?.audited ?? false };
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
        .from(tiktokPosts)
        .where(and(eq(tiktokPosts.id, id), eq(tiktokPosts.tenantId, ctx.tenantId)))
        .for('update');
      if (!p)
        throw new NotFoundException({
          code: 'TIKTOK_POST_NOT_FOUND',
          message: 'Không tìm thấy bài đăng TikTok',
        });
      if (!from.includes(p.status))
        throw new ConflictException({
          code: 'TIKTOK_STATE',
          message: 'Bài đang được đăng hoặc đã lên TikTok, không đổi được',
        });
      await tx
        .update(tiktokPosts)
        .set({ ...patch(p), updatedAt: new Date() })
        .where(eq(tiktokPosts.id, id));
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action,
        targetType: 'tiktok_post',
        targetId: id,
        metadata: { from: p.status },
        ip: ctx.ip,
      });
    });
  }

  private async one(ctx: Ctx, id: string): Promise<TiktokPostResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const [r] = await tx
        .select({
          p: tiktokPosts,
          itemTitle: contentItems.title,
          a: tiktokAccounts,
          name: users.displayName,
        })
        .from(tiktokPosts)
        .innerJoin(contentItems, eq(contentItems.id, tiktokPosts.itemId))
        .innerJoin(tiktokAccounts, eq(tiktokAccounts.id, tiktokPosts.accountId))
        .leftJoin(users, eq(users.id, tiktokPosts.createdBy))
        .where(and(eq(tiktokPosts.id, id), eq(tiktokPosts.tenantId, ctx.tenantId)));
      if (!r)
        throw new NotFoundException({
          code: 'TIKTOK_POST_NOT_FOUND',
          message: 'Không tìm thấy bài đăng TikTok',
        });
      return postResponse(r.p, r.itemTitle, r.a, r.name);
    });
  }
}

function postResponse(
  p: PostRow,
  itemTitle: string,
  a: AccountRow,
  name: string | null,
): TiktokPostResponse {
  const size = Number(p.stage.size ?? 0);
  const chunk = Number(p.stage.chunkSize ?? 0);
  const next = Number(p.stage.next ?? 0);
  const count = Number(p.stage.count ?? 0);
  const sent = next >= count ? size : next * chunk;
  return {
    id: p.id,
    itemId: p.itemId,
    itemTitle,
    version: p.version,
    accountId: a.id,
    accountName: a.username ? `@${a.username}` : a.displayName,
    mode: p.mode,
    title: p.title,
    privacy: p.privacy as TiktokPrivacy | null,
    allowComment: p.allowComment,
    allowDuet: p.allowDuet,
    allowStitch: p.allowStitch,
    brandOrganic: p.brandOrganic,
    brandedContent: p.brandedContent,
    aigc: p.aigc,
    scheduledAt: p.scheduledAt.toISOString(),
    status: p.status,
    attempts: p.attempts,
    uploadedPct:
      p.status === 'uploading' && size > 0 && p.stage.publishId
        ? Math.min(100, Math.round((sent / size) * 100))
        : null,
    postId: p.postId,
    url: p.postId ? tiktokUrl(a.username, p.postId) : null,
    warnings: p.warnings,
    errorCode: p.errorCode,
    errorMessage: p.errorMessage,
    createdByName: name ?? '',
    createdAt: p.createdAt.toISOString(),
    publishedAt: p.publishedAt?.toISOString() ?? null,
  };
}
