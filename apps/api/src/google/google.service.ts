import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  GOOGLE_BASE_SCOPES,
  GOOGLE_FEATURES,
  GOOGLE_LIMITS,
  GOOGLE_SERVICES,
  type ApiCallResponse,
  type GoogleCallback,
  type GoogleConnectionResponse,
  type GoogleOauthStart,
  type GoogleOauthStartResponse,
  type GoogleStatusResponse,
  type SetGoogleApp,
  type UpdateYoutubeChannel,
  type YoutubeChannelResponse,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { RedisService } from '../redis/redis.module';
import { SecretVaultService } from '../secrets/secret-vault.service';
import { GOOGLE_TOKEN_SCOPE, GoogleApiService, GoogleError } from './google-api.service';

const { googleApps, googleConnections, googleChannels, apiCalls, users, secrets } = schema;
type ConnectionRow = typeof googleConnections.$inferSelect;
type ChannelRow = typeof googleChannels.$inferSelect;

const STATE_TTL_SEC = 600;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const READ_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

interface ChannelData {
  id?: string;
  snippet?: {
    title?: string;
    customUrl?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string };
  status?: { longUploadsStatus?: string };
}

const count = (v: string | undefined) => (v && /^[0-9]{1,18}$/.test(v) ? Number(v) : null);

/**
 * Google Center (spec Part 16): the tenant's OAuth client, the Google accounts signed in through
 * Google's own consent screen (one service at a time, with only the scopes Google granted), and
 * the YouTube channels those accounts own (Part 17). Every call goes through GoogleApiService.
 */
@Injectable()
export class GoogleService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly vault: SecretVaultService,
    private readonly api: GoogleApiService,
    private readonly audit: AuditService,
  ) {}

  get redirectUri(): string {
    return `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/google/callback`;
  }

  async status(ctx: Ctx): Promise<GoogleStatusResponse> {
    return this.db.withContext(ctx, (tx) => this.statusIn(tx, ctx.tenantId));
  }

  async setApp(ctx: Ctx, input: SetGoogleApp): Promise<GoogleStatusResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const values = {
        clientId: input.clientId,
        clientSecretName: input.clientSecretName,
        youtubeQuota: input.youtubeQuota,
        youtubeAudited: input.youtubeAudited,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      };
      await tx
        .insert(googleApps)
        .values({ tenantId: ctx.tenantId, ...values })
        .onConflictDoUpdate({ target: googleApps.tenantId, set: values });
      await this.log(tx, ctx, 'google.app_set', null, {
        clientId: input.clientId,
        clientSecretName: input.clientSecretName,
        youtubeQuota: input.youtubeQuota,
        youtubeAudited: input.youtubeAudited,
      });
      return this.statusIn(tx, ctx.tenantId);
    });
  }

  /**
   * The address of Google's consent screen for the chosen services, with a one-time state bound
   * to this person and tenant and a PKCE code challenge.
   */
  async oauthStart(ctx: Ctx, input: GoogleOauthStart): Promise<GoogleOauthStartResponse> {
    const app = await this.db.withContext(ctx, (tx) => this.api.app(tx, ctx.tenantId));
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    await this.redis.client.set(
      `google:oauth:${sha(state)}`,
      JSON.stringify({ tenantId: ctx.tenantId, userId: ctx.userId, verifier }),
      'EX',
      STATE_TTL_SEC,
    );
    const scopes = [
      ...GOOGLE_BASE_SCOPES,
      ...input.services.flatMap((s) => GOOGLE_SERVICES[s].scopes),
    ];
    const url = new URL(`${this.config.GOOGLE_ACCOUNTS_URL.replace(/\/$/, '')}/o/oauth2/v2/auth`);
    url.search = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      // A refresh token, and the consent screen every time so Google always sends one.
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString() };
  }

  /**
   * Finishes sign-in: checks the state, trades the code for tokens, reads who signed in and which
   * scopes Google granted, stores the refresh token sealed and syncs the YouTube channels.
   */
  async oauthCallback(ctx: Ctx, input: GoogleCallback): Promise<GoogleStatusResponse> {
    const saved = await this.redis.client.getdel(`google:oauth:${sha(input.state)}`);
    const who = saved
      ? (JSON.parse(saved) as { tenantId: string; userId: string; verifier: string })
      : null;
    if (!who || who.tenantId !== ctx.tenantId || who.userId !== ctx.userId)
      throw new BadRequestException({
        code: 'GOOGLE_STATE_INVALID',
        message: 'Phiên đăng nhập Google không hợp lệ hoặc đã quá 10 phút. Bấm Kết nối lại.',
      });
    const app = await this.db.withContext(ctx, (tx) => this.api.app(tx, ctx.tenantId));
    const g = { tenantId: ctx.tenantId, userId: ctx.userId };
    const tok = await this.api.call<{
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
    }>(g, {
      service: 'oauth',
      priority: 'essential',
      method: 'POST',
      host: 'oauth',
      path: '/token',
      auth: { kind: 'none' },
      form: {
        grant_type: 'authorization_code',
        code: input.code,
        client_id: app.clientId,
        client_secret: app.secret,
        redirect_uri: this.redirectUri,
        code_verifier: who.verifier,
      },
    });
    const access = tok.body.access_token;
    if (!access) throw new GoogleError(502, 'GOOGLE_API_ERROR', 'Google không trả về mã truy cập');
    const scopes = [...new Set((tok.body.scope ?? '').split(/\s+/).filter(Boolean))]
      .filter((s) => /^[a-z0-9:/._-]{1,200}$/i.test(s))
      .sort();
    // Who signed in, with the new access token directly (the connection row does not exist yet).
    const me = (
      await this.api.call<{ sub?: string; email?: string; name?: string }>(g, {
        service: 'account',
        priority: 'essential',
        method: 'GET',
        host: 'api',
        path: '/oauth2/v3/userinfo',
        auth: { kind: 'token', token: access },
      })
    ).body;
    if (!me.sub || !/^[0-9]{1,40}$/.test(me.sub))
      throw new GoogleError(
        502,
        'GOOGLE_API_ERROR',
        'Google không cho biết tài khoản đã đăng nhập',
      );

    const id = await this.db.withContext(ctx, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`google-connections:${ctx.tenantId}`}))`,
      );
      const [current] = await tx
        .select()
        .from(googleConnections)
        .where(
          and(
            eq(googleConnections.tenantId, ctx.tenantId),
            eq(googleConnections.googleSub, me.sub!),
            ne(googleConnections.status, 'removed'),
          ),
        );
      const refresh = tok.body.refresh_token ?? null;
      if (!refresh && !current?.refreshTokenSealed)
        throw new ConflictException({
          code: 'GOOGLE_NO_REFRESH',
          message:
            'Google không cấp quyền dùng lâu dài. Vào myaccount.google.com → Bảo mật → Ứng dụng bên thứ ba, gỡ quyền của ứng dụng này rồi kết nối lại.',
        });
      if (!current) {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(googleConnections)
          .where(
            and(
              eq(googleConnections.tenantId, ctx.tenantId),
              ne(googleConnections.status, 'removed'),
            ),
          );
        if (n >= GOOGLE_LIMITS.connections)
          throw new ConflictException({
            code: 'GOOGLE_CONNECTION_LIMIT',
            message: `Gói BUSINESS cho tối đa ${GOOGLE_LIMITS.connections} tài khoản Google. Ngắt một tài khoản trước.`,
          });
      }
      const id = current?.id ?? uuidv7();
      // Google adds new scopes to what was granted before (include_granted_scopes).
      const all = [
        ...new Set([...(current?.status === 'active' ? current.scopes : []), ...scopes]),
      ].sort();
      const values = {
        email: (me.email ?? me.sub!).slice(0, 320),
        name: (me.name ?? me.email ?? me.sub!).slice(0, 200),
        refreshTokenSealed: refresh
          ? this.vault.sealFor(GOOGLE_TOKEN_SCOPE, ctx.tenantId, id, refresh)
          : current!.refreshTokenSealed,
        scopes: scopes.length ? all : (current?.scopes ?? []),
        status: 'active' as const,
        checkError: null,
        connectedBy: ctx.userId,
        connectedAt: new Date(),
      };
      if (current)
        await tx.update(googleConnections).set(values).where(eq(googleConnections.id, id));
      else
        await tx
          .insert(googleConnections)
          .values({ id, tenantId: ctx.tenantId, googleSub: me.sub!, ...values });
      await this.log(tx, ctx, 'google.connected', id, {
        googleSub: me.sub,
        scopes: values.scopes,
        reconnected: Boolean(current),
      });
      return id;
    });
    this.api.remember(id, access, tok.body.expires_in ?? 3600);
    await this.syncConnection(ctx, id, 'essential');
    return this.status(ctx);
  }

  /** Reads the YouTube channels of every active account again. */
  async sync(ctx: Ctx): Promise<GoogleStatusResponse> {
    const conns = await this.db.withContext(ctx, (tx) =>
      tx
        .select()
        .from(googleConnections)
        .where(
          and(eq(googleConnections.tenantId, ctx.tenantId), eq(googleConnections.status, 'active')),
        ),
    );
    if (!conns.length)
      throw new ConflictException({
        code: 'GOOGLE_NOT_CONNECTED',
        message: 'Chưa kết nối tài khoản Google',
      });
    for (const c of conns) await this.syncConnection(ctx, c.id, 'normal');
    return this.status(ctx);
  }

  async setChannel(
    ctx: Ctx,
    id: string,
    input: UpdateYoutubeChannel,
  ): Promise<YoutubeChannelResponse> {
    return this.db.withContext(ctx, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`google-channels:${ctx.tenantId}`}))`,
      );
      const [ch] = await tx
        .select()
        .from(googleChannels)
        .where(and(eq(googleChannels.id, id), eq(googleChannels.tenantId, ctx.tenantId)));
      if (!ch)
        throw new NotFoundException({
          code: 'YOUTUBE_CHANNEL_NOT_FOUND',
          message: 'Không tìm thấy kênh',
        });
      if (ch.removedAt)
        throw new ConflictException({
          code: 'YOUTUBE_CHANNEL_REMOVED',
          message: 'Tài khoản Google không còn quyền với kênh này',
        });
      if (input.enabled && !ch.enabled) {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(googleChannels)
          .where(and(eq(googleChannels.tenantId, ctx.tenantId), eq(googleChannels.enabled, true)));
        if (n >= GOOGLE_LIMITS.channels)
          throw new ConflictException({
            code: 'YOUTUBE_CHANNEL_LIMIT',
            message: `Gói BUSINESS cho tối đa ${GOOGLE_LIMITS.channels} kênh YouTube. Tắt một kênh khác trước.`,
          });
      }
      const [row] = await tx
        .update(googleChannels)
        .set({ enabled: input.enabled })
        .where(eq(googleChannels.id, id))
        .returning();
      await this.log(
        tx,
        ctx,
        input.enabled ? 'google.channel_enabled' : 'google.channel_disabled',
        id,
        { channelId: ch.channelId },
      );
      const [conn] = await tx
        .select({ email: googleConnections.email })
        .from(googleConnections)
        .where(eq(googleConnections.id, row!.connectionId));
      return channelResponse(row!, conn?.email ?? '');
    });
  }

  /**
   * Disconnects one Google account: asks Google to revoke the token (best effort, so a token that
   * already stopped working cannot block it) and erases it.
   */
  async disconnect(ctx: Ctx, id: string): Promise<GoogleStatusResponse> {
    const conn = await this.db.withContext(ctx, async (tx) => {
      const [c] = await tx
        .select()
        .from(googleConnections)
        .where(
          and(
            eq(googleConnections.id, id),
            eq(googleConnections.tenantId, ctx.tenantId),
            ne(googleConnections.status, 'removed'),
          ),
        );
      if (!c)
        throw new NotFoundException({
          code: 'GOOGLE_CONNECTION_NOT_FOUND',
          message: 'Không tìm thấy tài khoản Google',
        });
      return c;
    });
    let revoked = false;
    if (conn.refreshTokenSealed) {
      const token = this.vault.openFor(
        GOOGLE_TOKEN_SCOPE,
        ctx.tenantId,
        conn.id,
        conn.refreshTokenSealed,
      );
      revoked = await this.api
        .call(
          { tenantId: ctx.tenantId, userId: ctx.userId },
          {
            service: 'oauth',
            priority: 'essential',
            method: 'POST',
            host: 'oauth',
            path: '/revoke',
            auth: { kind: 'none' },
            form: { token },
          },
        )
        .then(() => true)
        .catch(() => false);
    }
    this.api.forget(conn.id);
    return this.db.withContext(ctx, async (tx) => {
      const now = new Date();
      await tx
        .update(googleConnections)
        .set({ status: 'removed', refreshTokenSealed: null, removedAt: now })
        .where(eq(googleConnections.id, conn.id));
      await tx
        .update(googleChannels)
        .set({ enabled: false, removedAt: now })
        .where(and(eq(googleChannels.connectionId, conn.id), isNull(googleChannels.removedAt)));
      await this.log(tx, ctx, 'google.disconnected', conn.id, {
        googleSub: conn.googleSub,
        revokedAtGoogle: revoked,
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
        .where(and(eq(apiCalls.tenantId, ctx.tenantId), eq(apiCalls.provider, 'google')))
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
        units: c.units,
        calledByName: name,
        createdAt: c.createdAt.toISOString(),
      }));
    });
  }

  private async syncConnection(
    ctx: Ctx,
    connectionId: string,
    priority: 'essential' | 'normal',
  ): Promise<void> {
    const conn = await this.db.withContext(ctx, async (tx) => {
      const [c] = await tx
        .select()
        .from(googleConnections)
        .where(eq(googleConnections.id, connectionId));
      return c!;
    });
    // Without the YouTube read scope MARIS cannot see the channels: it keeps what it has.
    if (!conn.scopes.includes(READ_SCOPE)) return;
    const r = await this.api.call<{ items?: ChannelData[] }>(ctx, {
      service: 'youtube',
      call: 'list',
      priority,
      method: 'GET',
      host: 'api',
      path: '/youtube/v3/channels',
      params: { part: 'snippet,statistics,status', mine: 'true', maxResults: 50 },
      auth: { kind: 'connection', connectionId },
    });
    const items = (r.body.items ?? []).filter((c) => /^UC[A-Za-z0-9_-]{22}$/.test(c.id ?? ''));
    await this.db.withContext(ctx, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`google-channels:${ctx.tenantId}`}))`,
      );
      const existing = await tx
        .select()
        .from(googleChannels)
        .where(eq(googleChannels.tenantId, ctx.tenantId));
      const byId = new Map(existing.map((c) => [c.channelId, c]));
      let enabledCount = existing.filter((c) => c.enabled).length;
      const now = new Date();
      const seen = new Set<string>();
      for (const c of items) {
        seen.add(c.id!);
        const thumbs = c.snippet?.thumbnails ?? {};
        const thumb = thumbs.medium?.url ?? thumbs.default?.url ?? null;
        const fields = {
          connectionId,
          title: (c.snippet?.title ?? c.id!).slice(0, 300),
          customUrl: c.snippet?.customUrl?.slice(0, 200) ?? null,
          thumbnailUrl: thumb?.startsWith('https://') ? thumb.slice(0, 2000) : null,
          subscribers: count(c.statistics?.subscriberCount),
          videos: count(c.statistics?.videoCount),
          views: count(c.statistics?.viewCount),
          longUploads: c.status?.longUploadsStatus?.slice(0, 40) ?? null,
          syncedAt: now,
        };
        const old = byId.get(c.id!);
        if (old) {
          await tx
            .update(googleChannels)
            .set({
              ...fields,
              removedAt: null,
              enabled: old.removedAt ? false : old.enabled,
            })
            .where(eq(googleChannels.id, old.id));
        } else {
          const enabled = enabledCount < GOOGLE_LIMITS.channels;
          if (enabled) enabledCount++;
          await tx.insert(googleChannels).values({
            id: uuidv7(),
            tenantId: ctx.tenantId,
            channelId: c.id!,
            ...fields,
            enabled,
          });
        }
      }
      let removed = 0;
      for (const c of existing)
        if (c.connectionId === connectionId && !seen.has(c.channelId) && !c.removedAt) {
          removed++;
          await tx
            .update(googleChannels)
            .set({ enabled: false, removedAt: now })
            .where(eq(googleChannels.id, c.id));
        }
      await tx
        .update(googleConnections)
        .set({ syncedAt: now })
        .where(eq(googleConnections.id, connectionId));
      await this.log(tx, ctx, 'google.synced', connectionId, { channels: items.length, removed });
    });
  }

  private async statusIn(tx: Tx, tenantId: string): Promise<GoogleStatusResponse> {
    const [app] = await tx.select().from(googleApps).where(eq(googleApps.tenantId, tenantId));
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
    const conns = await tx
      .select({ c: googleConnections, name: users.displayName })
      .from(googleConnections)
      .leftJoin(users, eq(users.id, googleConnections.connectedBy))
      .where(and(eq(googleConnections.tenantId, tenantId), ne(googleConnections.status, 'removed')))
      .orderBy(asc(googleConnections.connectedAt));
    const emails = new Map(conns.map(({ c }) => [c.id, c.email]));
    const channels = await tx
      .select()
      .from(googleChannels)
      .where(eq(googleChannels.tenantId, tenantId))
      .orderBy(asc(googleChannels.title));
    return {
      app: app
        ? {
            clientId: app.clientId,
            clientSecretName: app.clientSecretName,
            secretFound: Boolean(secret),
            youtubeQuota: app.youtubeQuota,
            youtubeAudited: app.youtubeAudited,
          }
        : null,
      redirectUri: this.redirectUri,
      connections: conns.map(({ c, name }) => connectionResponse(c, name)),
      // Channels of disconnected accounts are not shown.
      channels: channels
        .filter((c) => emails.has(c.connectionId))
        .map((c) => channelResponse(c, emails.get(c.connectionId) ?? '')),
      quota: await this.api.quota(tx, tenantId),
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
      targetType: 'google',
      targetId,
      metadata,
      ip: ctx.ip,
    });
  }
}

function connectionResponse(c: ConnectionRow, name: string | null): GoogleConnectionResponse {
  const scopes = c.status === 'active' ? c.scopes : [];
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    status: c.status === 'active' ? 'active' : 'invalid',
    scopes: c.scopes,
    features: GOOGLE_FEATURES.map((f) => ({
      key: f.key,
      label: f.label,
      ready: f.scopes.every((s) => scopes.includes(s)),
    })),
    checkError: c.checkError,
    connectedByName: name ?? '',
    connectedAt: c.connectedAt.toISOString(),
    syncedAt: c.syncedAt?.toISOString() ?? null,
  };
}

export function channelResponse(c: ChannelRow, email: string): YoutubeChannelResponse {
  return {
    id: c.id,
    connectionId: c.connectionId,
    connectionEmail: email,
    channelId: c.channelId,
    title: c.title,
    customUrl: c.customUrl,
    thumbnailUrl: c.thumbnailUrl,
    subscribers: c.subscribers,
    videos: c.videos,
    views: c.views,
    longUploads: c.longUploads,
    enabled: c.enabled,
    removed: c.removedAt !== null,
    syncedAt: c.syncedAt.toISOString(),
  };
}
