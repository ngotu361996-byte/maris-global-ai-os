import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  TIKTOK_BASE_SCOPES,
  TIKTOK_FEATURES,
  TIKTOK_LIMITS,
  TIKTOK_SERVICES,
  type ApiCallResponse,
  type SetTiktokApp,
  type TiktokAccountResponse,
  type TiktokCallback,
  type TiktokCreatorResponse,
  type TiktokOauthStart,
  type TiktokOauthStartResponse,
  type TiktokPrivacy,
  type TiktokReportResponse,
  type TiktokStatusResponse,
  type TiktokVideoResponse,
  type UpdateTiktokAccount,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { RedisService } from '../redis/redis.module';
import { SecretVaultService } from '../secrets/secret-vault.service';
import { creatorFromBody } from './rules';
import { TIKTOK_TOKEN_SCOPE, TiktokApiService, TiktokError } from './tiktok-api.service';

const { tiktokApps, tiktokAccounts, tiktokPosts, tiktokVideos, apiCalls, users, secrets } = schema;
type AccountRow = typeof tiktokAccounts.$inferSelect;
type VideoRow = typeof tiktokVideos.$inferSelect;

const STATE_TTL_SEC = 600;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Pages of 20 videos read on each sync. */
const VIDEO_PAGES = 3;

interface TiktokUser {
  open_id?: string;
  display_name?: string;
  username?: string;
  avatar_url?: string;
  follower_count?: number;
  following_count?: number;
  likes_count?: number;
  video_count?: number;
}

interface TiktokVideo {
  id?: string;
  title?: string;
  video_description?: string;
  cover_image_url?: string;
  share_url?: string;
  create_time?: number;
  duration?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
}

const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
const https = (v: unknown, max = 2000) =>
  typeof v === 'string' && v.startsWith('https://') ? v.slice(0, max) : null;

/**
 * TikTok Center (spec Part 17, M19): the tenant's TikTok app, the TikTok accounts signed in through
 * TikTok's own Login Kit page (one service at a time, with only the scopes TikTok granted), what
 * each creator may post, and the accounts' videos with their figures. Every call goes through
 * TiktokApiService.
 */
@Injectable()
export class TiktokService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly vault: SecretVaultService,
    private readonly api: TiktokApiService,
    private readonly audit: AuditService,
  ) {}

  /**
   * TikTok's Login Kit for desktop apps accepts http://localhost addresses, which is how MARIS runs
   * on a company computer; a web app needs https.
   */
  get redirectUri(): string {
    return `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/tiktok/callback`;
  }

  async status(ctx: Ctx): Promise<TiktokStatusResponse> {
    return this.db.withContext(ctx, (tx) => this.statusIn(tx, ctx.tenantId));
  }

  async setApp(ctx: Ctx, input: SetTiktokApp): Promise<TiktokStatusResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const values = {
        clientKey: input.clientKey,
        clientSecretName: input.clientSecretName,
        audited: input.audited,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      };
      await tx
        .insert(tiktokApps)
        .values({ tenantId: ctx.tenantId, ...values })
        .onConflictDoUpdate({ target: tiktokApps.tenantId, set: values });
      await this.log(tx, ctx, 'tiktok.app_set', null, {
        clientKey: input.clientKey,
        clientSecretName: input.clientSecretName,
        audited: input.audited,
      });
      return this.statusIn(tx, ctx.tenantId);
    });
  }

  /**
   * The address of TikTok's authorization page for the chosen services, with a one-time state
   * bound to this person and tenant and a PKCE challenge (TikTok's form: SHA-256 as hex).
   */
  async oauthStart(ctx: Ctx, input: TiktokOauthStart): Promise<TiktokOauthStartResponse> {
    const app = await this.db.withContext(ctx, (tx) => this.api.app(tx, ctx.tenantId));
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    await this.redis.client.set(
      `tiktok:oauth:${sha(state)}`,
      JSON.stringify({ tenantId: ctx.tenantId, userId: ctx.userId, verifier }),
      'EX',
      STATE_TTL_SEC,
    );
    const scopes = [
      ...new Set([
        ...TIKTOK_BASE_SCOPES,
        ...input.services.flatMap((s) => TIKTOK_SERVICES[s].scopes),
      ]),
    ];
    const url = new URL(`${this.config.TIKTOK_AUTH_URL.replace(/\/$/, '')}/v2/auth/authorize/`);
    url.search = new URLSearchParams({
      client_key: app.clientKey,
      response_type: 'code',
      scope: scopes.join(','),
      redirect_uri: this.redirectUri,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('hex'),
      code_challenge_method: 'S256',
      // Always show the page, so the person sees which account and which permissions.
      disable_auto_auth: '1',
    }).toString();
    return { url: url.toString() };
  }

  /**
   * Finishes sign-in: checks the state, trades the code for tokens, reads who signed in and which
   * scopes TikTok granted, stores the refresh token sealed and reads the account's figures.
   */
  async oauthCallback(ctx: Ctx, input: TiktokCallback): Promise<TiktokStatusResponse> {
    const saved = await this.redis.client.getdel(`tiktok:oauth:${sha(input.state)}`);
    const who = saved
      ? (JSON.parse(saved) as { tenantId: string; userId: string; verifier: string })
      : null;
    if (!who || who.tenantId !== ctx.tenantId || who.userId !== ctx.userId)
      throw new BadRequestException({
        code: 'TIKTOK_STATE_INVALID',
        message: 'Phiên đăng nhập TikTok không hợp lệ hoặc đã quá 10 phút. Bấm Kết nối lại.',
      });
    const app = await this.db.withContext(ctx, (tx) => this.api.app(tx, ctx.tenantId));
    const t = { tenantId: ctx.tenantId, userId: ctx.userId };
    const tok = (
      await this.api.call<{
        access_token?: string;
        expires_in?: number;
        open_id?: string;
        refresh_token?: string;
        refresh_expires_in?: number;
        scope?: string;
      }>(t, {
        group: 'oauth',
        method: 'POST',
        path: '/v2/oauth/token/',
        auth: { kind: 'none' },
        form: {
          client_key: app.clientKey,
          client_secret: app.secret,
          code: input.code,
          grant_type: 'authorization_code',
          redirect_uri: this.redirectUri,
          code_verifier: who.verifier,
        },
      })
    ).body;
    const access = tok.access_token;
    if (!access || !tok.refresh_token)
      throw new TiktokError(502, 'TIKTOK_API_ERROR', 'TikTok không trả về mã truy cập');
    const scopes = [...new Set((tok.scope ?? '').split(/[,\s]+/).filter(Boolean))]
      .filter((s) => /^[a-z0-9._]{1,60}$/i.test(s))
      .sort();
    const me = await this.readUser(t, { kind: 'token', token: access }, scopes);
    const openId = me.open_id ?? tok.open_id;
    if (!openId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(openId))
      throw new TiktokError(502, 'TIKTOK_API_ERROR', 'TikTok không cho biết tài khoản đã đăng nhập');

    const id = await this.db.withContext(ctx, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`tiktok-accounts:${ctx.tenantId}`}))`,
      );
      const [current] = await tx
        .select()
        .from(tiktokAccounts)
        .where(
          and(
            eq(tiktokAccounts.tenantId, ctx.tenantId),
            eq(tiktokAccounts.openId, openId),
            ne(tiktokAccounts.status, 'removed'),
          ),
        );
      if (!current) {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(tiktokAccounts)
          .where(
            and(eq(tiktokAccounts.tenantId, ctx.tenantId), ne(tiktokAccounts.status, 'removed')),
          );
        if (n >= TIKTOK_LIMITS.accounts)
          throw new ConflictException({
            code: 'TIKTOK_ACCOUNT_LIMIT',
            message: `Gói BUSINESS cho tối đa ${TIKTOK_LIMITS.accounts} tài khoản TikTok. Ngắt một tài khoản trước.`,
          });
      }
      const id = current?.id ?? uuidv7();
      const values = {
        ...userFields(me),
        refreshTokenSealed: this.vault.sealFor(TIKTOK_TOKEN_SCOPE, ctx.tenantId, id, tok.refresh_token!),
        refreshExpiresAt: new Date(Date.now() + (tok.refresh_expires_in ?? 365 * 86_400) * 1000),
        // TikTok sends every scope the person granted this app, old and new.
        scopes,
        status: 'active' as const,
        checkError: null,
        connectedBy: ctx.userId,
        connectedAt: new Date(),
      };
      if (current) await tx.update(tiktokAccounts).set(values).where(eq(tiktokAccounts.id, id));
      else
        await tx.insert(tiktokAccounts).values({ id, tenantId: ctx.tenantId, openId, ...values });
      await this.log(tx, ctx, 'tiktok.connected', id, {
        openId,
        scopes,
        reconnected: Boolean(current),
      });
      return id;
    });
    this.api.remember(id, access, tok.expires_in ?? 86_400);
    await this.syncAccount(ctx, id);
    return this.status(ctx);
  }

  /** Reads every active account again: profile, figures, what it may post, its videos. */
  async sync(ctx: Ctx): Promise<TiktokStatusResponse> {
    const accounts = await this.db.withContext(ctx, (tx) =>
      tx
        .select()
        .from(tiktokAccounts)
        .where(and(eq(tiktokAccounts.tenantId, ctx.tenantId), eq(tiktokAccounts.status, 'active'))),
    );
    if (!accounts.length)
      throw new ConflictException({
        code: 'TIKTOK_NOT_CONNECTED',
        message: 'Chưa kết nối tài khoản TikTok',
      });
    for (const a of accounts) await this.syncAccount(ctx, a.id);
    return this.status(ctx);
  }

  async setAccount(
    ctx: Ctx,
    id: string,
    input: UpdateTiktokAccount,
  ): Promise<TiktokAccountResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const [a] = await tx
        .select()
        .from(tiktokAccounts)
        .where(
          and(
            eq(tiktokAccounts.id, id),
            eq(tiktokAccounts.tenantId, ctx.tenantId),
            ne(tiktokAccounts.status, 'removed'),
          ),
        );
      if (!a)
        throw new NotFoundException({
          code: 'TIKTOK_ACCOUNT_NOT_FOUND',
          message: 'Không tìm thấy tài khoản TikTok',
        });
      const [row] = await tx
        .update(tiktokAccounts)
        .set({ enabled: input.enabled })
        .where(eq(tiktokAccounts.id, id))
        .returning();
      await this.log(
        tx,
        ctx,
        input.enabled ? 'tiktok.account_enabled' : 'tiktok.account_disabled',
        id,
        { openId: a.openId },
      );
      const counts = await this.postsToday(tx, ctx.tenantId);
      return accountResponse(row!, null, counts.get(id) ?? 0);
    });
  }

  /**
   * Disconnects one TikTok account: asks TikTok to revoke its access (best effort, so a token that
   * already stopped working cannot block it) and erases the token.
   */
  async disconnect(ctx: Ctx, id: string): Promise<TiktokStatusResponse> {
    const { account, app } = await this.db.withContext(ctx, async (tx) => {
      const [a] = await tx
        .select()
        .from(tiktokAccounts)
        .where(
          and(
            eq(tiktokAccounts.id, id),
            eq(tiktokAccounts.tenantId, ctx.tenantId),
            ne(tiktokAccounts.status, 'removed'),
          ),
        );
      if (!a)
        throw new NotFoundException({
          code: 'TIKTOK_ACCOUNT_NOT_FOUND',
          message: 'Không tìm thấy tài khoản TikTok',
        });
      const app = await this.api.app(tx, ctx.tenantId).catch(() => null);
      return { account: a, app };
    });
    let revoked = false;
    if (account.refreshTokenSealed && app) {
      const token = this.vault.openFor(
        TIKTOK_TOKEN_SCOPE,
        ctx.tenantId,
        account.id,
        account.refreshTokenSealed,
      );
      revoked = await this.api
        .call(
          { tenantId: ctx.tenantId, userId: ctx.userId },
          {
            group: 'oauth',
            method: 'POST',
            path: '/v2/oauth/revoke/',
            auth: { kind: 'none' },
            form: { client_key: app.clientKey, client_secret: app.secret, token },
          },
        )
        .then(() => true)
        .catch(() => false);
    }
    this.api.forget(account.id);
    return this.db.withContext(ctx, async (tx) => {
      await tx
        .update(tiktokAccounts)
        .set({
          status: 'removed',
          enabled: false,
          refreshTokenSealed: null,
          removedAt: new Date(),
        })
        .where(eq(tiktokAccounts.id, account.id));
      await this.log(tx, ctx, 'tiktok.disconnected', account.id, {
        openId: account.openId,
        revokedAtTiktok: revoked,
      });
      return this.statusIn(tx, ctx.tenantId);
    });
  }

  async calls(ctx: Ctx): Promise<ApiCallResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select({ c: apiCalls, name: users.displayName })
        .from(apiCalls)
        .leftJoin(users, eq(users.id, apiCalls.calledBy))
        .where(and(eq(apiCalls.tenantId, ctx.tenantId), eq(apiCalls.provider, 'tiktok')))
        .orderBy(desc(apiCalls.createdAt), desc(apiCalls.id))
        .limit(50);
      return rows.map(({ c, name }) => ({
        id: c.id,
        group: c.apiGroup,
        method: c.method,
        path: c.path,
        outcome: c.outcome,
        httpStatus: c.httpStatus,
        errorCode: c.errorCode,
        errorMessage: c.errorMessage,
        durationMs: c.durationMs,
        calledByName: name,
        createdAt: c.createdAt.toISOString(),
      }));
    });
  }

  /** The accounts' videos MARIS has read, newest first. */
  async videos(ctx: Ctx, accountId?: string): Promise<TiktokVideoResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select({ v: tiktokVideos, name: tiktokAccounts.displayName })
        .from(tiktokVideos)
        .innerJoin(tiktokAccounts, eq(tiktokAccounts.id, tiktokVideos.accountId))
        .where(
          and(
            eq(tiktokVideos.tenantId, ctx.tenantId),
            ne(tiktokAccounts.status, 'removed'),
            accountId ? eq(tiktokVideos.accountId, accountId) : undefined,
          ),
        )
        .orderBy(sql`${tiktokVideos.postedAt} DESC NULLS LAST`, desc(tiktokVideos.id))
        .limit(200);
      return rows.map(({ v, name }) => videoResponse(v, name));
    });
  }

  /** Figures of the videos posted in the last `days` days, and the ones with most views. */
  async report(ctx: Ctx, days = 30): Promise<TiktokReportResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await tx
        .select({ v: tiktokVideos, name: tiktokAccounts.displayName })
        .from(tiktokVideos)
        .innerJoin(tiktokAccounts, eq(tiktokAccounts.id, tiktokVideos.accountId))
        .where(
          and(
            eq(tiktokVideos.tenantId, ctx.tenantId),
            ne(tiktokAccounts.status, 'removed'),
            gte(tiktokVideos.postedAt, since),
          ),
        );
      const sum = (k: 'views' | 'likes' | 'comments' | 'shares') =>
        rows.reduce((s, { v }) => s + (v[k] ?? 0), 0);
      const views = sum('views');
      const likes = sum('likes');
      const comments = sum('comments');
      const shares = sum('shares');
      return {
        days,
        videos: rows.length,
        views,
        likes,
        comments,
        shares,
        engagementPct:
          views > 0 ? Math.round(((likes + comments + shares) / views) * 1000) / 10 : null,
        top: rows
          .sort((a, b) => (b.v.views ?? 0) - (a.v.views ?? 0))
          .slice(0, 5)
          .map(({ v, name }) => videoResponse(v, name)),
      };
    });
  }

  /** creatorInfo for a person's request: the account must be this tenant's and active. */
  async creatorFor(ctx: Ctx, accountId: string): Promise<TiktokCreatorResponse> {
    const [a] = await this.db.withContext(ctx, (tx) =>
      tx
        .select()
        .from(tiktokAccounts)
        .where(and(eq(tiktokAccounts.id, accountId), eq(tiktokAccounts.tenantId, ctx.tenantId))),
    );
    if (!a || a.status === 'removed')
      throw new NotFoundException({
        code: 'TIKTOK_ACCOUNT_NOT_FOUND',
        message: 'Không tìm thấy tài khoản TikTok',
      });
    if (!a.scopes.includes('video.publish'))
      throw new ConflictException({
        code: 'TIKTOK_PERMISSION',
        message: 'Tài khoản chưa cho MARIS quyền đăng thẳng',
      });
    return this.creatorInfo({ tenantId: ctx.tenantId, userId: ctx.userId }, accountId);
  }

  /** What TikTok says this creator may post now; kept on the account. */
  async creatorInfo(ctx: { tenantId: string; userId: string | null }, accountId: string) {
    const r = await this.api.call<{ data?: Record<string, unknown> }>(ctx, {
      group: 'post',
      method: 'POST',
      path: '/v2/post/publish/creator_info/query/',
      json: {},
      auth: { kind: 'account', accountId },
    });
    const creator = creatorFromBody(r.body.data);
    await this.db.withContext(ctx, (tx) =>
      tx.update(tiktokAccounts).set({ creator }).where(eq(tiktokAccounts.id, accountId)),
    );
    return creator;
  }

  private async readUser(
    ctx: { tenantId: string; userId: string | null },
    auth: { kind: 'token'; token: string } | { kind: 'account'; accountId: string },
    scopes: string[],
  ): Promise<TiktokUser> {
    const fields = ['open_id', 'avatar_url', 'display_name'];
    if (scopes.includes('user.info.profile')) fields.push('username');
    if (scopes.includes('user.info.stats'))
      fields.push('follower_count', 'following_count', 'likes_count', 'video_count');
    const r = await this.api.call<{ data?: { user?: TiktokUser } }>(ctx, {
      group: 'user',
      method: 'GET',
      path: '/v2/user/info/',
      params: { fields: fields.join(',') },
      auth,
      ...(auth.kind === 'account' ? { accountId: auth.accountId } : {}),
    });
    return r.body.data?.user ?? {};
  }

  private async syncAccount(ctx: Ctx, accountId: string): Promise<void> {
    const account = await this.db.withContext(ctx, async (tx) => {
      const [a] = await tx.select().from(tiktokAccounts).where(eq(tiktokAccounts.id, accountId));
      return a!;
    });
    const t = { tenantId: ctx.tenantId, userId: ctx.userId };
    const auth = { kind: 'account' as const, accountId };
    const me = await this.readUser(t, auth, account.scopes);
    if (account.scopes.includes('video.publish')) await this.creatorInfo(t, accountId);
    const videos: TiktokVideo[] = [];
    if (account.scopes.includes('video.list')) {
      let cursor: number | undefined;
      for (let page = 0; page < VIDEO_PAGES; page++) {
        const r = await this.api.call<{
          data?: { videos?: TiktokVideo[]; cursor?: number; has_more?: boolean };
        }>(t, {
          group: 'video',
          method: 'POST',
          path: '/v2/video/list/',
          params: {
            fields:
              'id,title,video_description,cover_image_url,share_url,create_time,duration,view_count,like_count,comment_count,share_count',
          },
          json: { max_count: 20, ...(cursor !== undefined ? { cursor } : {}) },
          auth,
        });
        videos.push(...(r.body.data?.videos ?? []));
        if (!r.body.data?.has_more || r.body.data.cursor === undefined) break;
        cursor = r.body.data.cursor;
      }
    }
    await this.db.withContext(ctx, async (tx) => {
      const now = new Date();
      await tx
        .update(tiktokAccounts)
        .set({ ...userFields(me, account), syncedAt: now })
        .where(eq(tiktokAccounts.id, accountId));
      let saved = 0;
      for (const v of videos) {
        if (!v.id || !/^[0-9]{1,30}$/.test(v.id)) continue;
        saved++;
        const fields = {
          title: (v.title || v.video_description || '').slice(0, 2200),
          coverUrl: https(v.cover_image_url),
          shareUrl: https(v.share_url),
          postedAt: num(v.create_time) !== null ? new Date(num(v.create_time)! * 1000) : null,
          durationSec: num(v.duration),
          views: num(v.view_count),
          likes: num(v.like_count),
          comments: num(v.comment_count),
          shares: num(v.share_count),
          syncedAt: now,
        };
        await tx
          .insert(tiktokVideos)
          .values({
            id: uuidv7(),
            tenantId: ctx.tenantId,
            accountId,
            videoId: v.id,
            ...fields,
          })
          .onConflictDoUpdate({
            target: [tiktokVideos.accountId, tiktokVideos.videoId],
            set: fields,
          });
      }
      await this.log(tx, ctx, 'tiktok.synced', accountId, { videos: saved });
    });
  }

  /** Posts per account in the last 24 hours, counting the ones under way. */
  private async postsToday(tx: Tx, tenantId: string): Promise<Map<string, number>> {
    const rows = await tx
      .select({ accountId: tiktokPosts.accountId, n: sql<number>`count(*)::int` })
      .from(tiktokPosts)
      .where(
        and(
          eq(tiktokPosts.tenantId, tenantId),
          or(
            inArray(tiktokPosts.status, ['uploading', 'processing']),
            gte(tiktokPosts.publishedAt, new Date(Date.now() - 86_400_000)),
          ),
        ),
      )
      .groupBy(tiktokPosts.accountId);
    return new Map(rows.map((r) => [r.accountId, r.n]));
  }

  async postsTodayFor(tx: Tx, tenantId: string, accountId: string): Promise<number> {
    return (await this.postsToday(tx, tenantId)).get(accountId) ?? 0;
  }

  private async statusIn(tx: Tx, tenantId: string): Promise<TiktokStatusResponse> {
    const [app] = await tx.select().from(tiktokApps).where(eq(tiktokApps.tenantId, tenantId));
    const [secret] = app
      ? await tx
          .select({ id: secrets.id })
          .from(secrets)
          .where(
            and(
              eq(secrets.tenantId, tenantId),
              eq(secrets.name, app.clientSecretName),
              isNull(secrets.deletedAt),
            ),
          )
      : [];
    const rows = await tx
      .select({ a: tiktokAccounts, name: users.displayName })
      .from(tiktokAccounts)
      .leftJoin(users, eq(users.id, tiktokAccounts.connectedBy))
      .where(and(eq(tiktokAccounts.tenantId, tenantId), ne(tiktokAccounts.status, 'removed')))
      .orderBy(asc(tiktokAccounts.connectedAt));
    const counts = await this.postsToday(tx, tenantId);
    return {
      app: app
        ? {
            clientKey: app.clientKey,
            clientSecretName: app.clientSecretName,
            secretFound: Boolean(secret),
            audited: app.audited,
          }
        : null,
      redirectUri: this.redirectUri,
      accounts: rows.map(({ a, name }) => accountResponse(a, name, counts.get(a.id) ?? 0)),
    };
  }

  private log(
    tx: Tx,
    ctx: Ctx,
    action: string,
    targetId: string | null,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'tiktok',
      targetId,
      metadata,
      ip: ctx.ip,
    });
  }
}

/** Profile fields from user/info; a field TikTok did not send keeps what MARIS had. */
function userFields(me: TiktokUser, old?: AccountRow) {
  return {
    displayName: (me.display_name || old?.displayName || me.open_id || 'TikTok').slice(0, 200),
    username:
      typeof me.username === 'string' && me.username
        ? me.username.slice(0, 100)
        : (old?.username ?? null),
    avatarUrl: https(me.avatar_url) ?? old?.avatarUrl ?? null,
    followers: num(me.follower_count) ?? old?.followers ?? null,
    following: num(me.following_count) ?? old?.following ?? null,
    likes: num(me.likes_count) ?? old?.likes ?? null,
    videoCount: num(me.video_count) ?? old?.videoCount ?? null,
  };
}

export function accountResponse(
  a: AccountRow,
  name: string | null,
  postsToday: number,
): TiktokAccountResponse {
  const scopes = a.status === 'active' ? a.scopes : [];
  return {
    id: a.id,
    openId: a.openId,
    displayName: a.displayName,
    username: a.username,
    avatarUrl: a.avatarUrl,
    status: a.status === 'active' ? 'active' : 'invalid',
    enabled: a.enabled,
    scopes: a.scopes,
    features: TIKTOK_FEATURES.map((f) => ({
      key: f.key,
      label: f.label,
      ready: f.scopes.every((s) => scopes.includes(s)),
    })),
    followers: a.followers,
    following: a.following,
    likes: a.likes,
    videoCount: a.videoCount,
    creator: a.creator
      ? { ...a.creator, privacyOptions: a.creator.privacyOptions as TiktokPrivacy[] }
      : null,
    postsToday,
    checkError: a.checkError,
    connectedByName: name ?? '',
    connectedAt: a.connectedAt.toISOString(),
    syncedAt: a.syncedAt?.toISOString() ?? null,
    refreshExpiresAt: a.refreshExpiresAt?.toISOString() ?? null,
  };
}

function videoResponse(v: VideoRow, accountName: string): TiktokVideoResponse {
  return {
    id: v.id,
    accountId: v.accountId,
    accountName,
    videoId: v.videoId,
    title: v.title,
    coverUrl: v.coverUrl,
    shareUrl: v.shareUrl,
    postedAt: v.postedAt?.toISOString() ?? null,
    durationSec: v.durationSec,
    views: v.views,
    likes: v.likes,
    comments: v.comments,
    shares: v.shares,
    syncedAt: v.syncedAt.toISOString(),
  };
}
