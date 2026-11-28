import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, ne, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  YOUTUBE_COSTS,
  type ApiPriority,
  type QuotaResponse,
  type YoutubeCall,
} from '@maris/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { RedisService } from '../redis/redis.module';
import { SecretVaultService } from '../secrets/secret-vault.service';
import {
  googleErrorKind,
  googleErrorMessage,
  googleErrorReason,
  quotaDayStart,
  quotaRefusal,
  quotaResetAt,
  quotaState,
  type GoogleErrorKind,
} from './quota';

const { googleApps, googleConnections, apiCalls } = schema;

export const GOOGLE_TOKEN_SCOPE = 'google-refresh';

const TIMEOUT_MS = 30_000;
const MAX_BODY = 2 * 1024 * 1024;
/** Wait after Google says "too many requests" without saying how long. */
const RATE_BLOCK_MIN = 5;
/** Refresh an access token this long before Google says it expires. */
const TOKEN_MARGIN_MS = 2 * 60_000;

export type GoogleAuth =
  | { kind: 'connection'; connectionId: string }
  | { kind: 'token'; token: string }
  | { kind: 'none' };

export interface GoogleRequest {
  /** What the call is for; YouTube calls count against the YouTube quota. */
  service: 'youtube' | 'oauth' | 'account' | 'analytics' | 'search_console';
  /** The quota cost of a YouTube call, from Google's table. */
  call?: YoutubeCall;
  priority: ApiPriority;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  host: 'api' | 'oauth' | 'analytics_data' | 'analytics_admin' | 'search_console';
  /** Starting with "/"; logged without the query string. */
  path: string;
  params?: Record<string, string | number | boolean>;
  json?: unknown;
  form?: Record<string, string>;
  body?: Blob;
  headers?: Record<string, string>;
  /** An upload session address from Google, used instead of host and path (never logged). */
  sessionUrl?: string;
  auth: GoogleAuth;
  channelId?: string;
  /** Answers other than 2xx that are not errors (308: the upload is not complete). */
  accept?: number[];
  timeoutMs?: number;
}

export interface GoogleResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export interface GoogleCtx {
  tenantId: string;
  userId: string | null;
}

export class GoogleError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly kind: GoogleErrorKind | 'network' | 'refused' = 'other',
    readonly retryAt: Date | null = null,
  ) {
    super({ code, message }, status);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The managed gateway for every call to Google (spec Parts 15 and 16). It gets a fresh access
 * token from the sealed refresh token, keeps the YouTube quota of the day (counted from midnight
 * Pacific time in integration.api_calls), stops calls for as long as Google asks, retries reads
 * that failed for a passing reason, and records every call with its quota units. Tokens go in the
 * Authorization header and are never logged.
 */
@Injectable()
export class GoogleApiService {
  private readonly tokens = new Map<string, { token: string; exp: number }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly vault: SecretVaultService,
  ) {}

  async call<T = Record<string, unknown>>(
    ctx: GoogleCtx,
    req: GoogleRequest,
  ): Promise<GoogleResponse<T>> {
    const cost = req.service === 'youtube' && req.call ? YOUTUBE_COSTS[req.call] : 0;
    const attempts = req.method === 'GET' ? 3 : 1;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      if (req.service === 'youtube') {
        const refusal = await this.refusal(ctx, cost, req.priority);
        if (refusal) {
          await this.log(ctx, req, 0, {
            outcome: 'refused',
            errorCode: refusal.code,
            message: refusal.message,
          });
          throw refusal;
        }
      }
      const token =
        req.auth.kind === 'connection'
          ? await this.accessToken(ctx, req.auth.connectionId)
          : req.auth.kind === 'token'
            ? req.auth.token
            : null;
      const started = Date.now();
      let res: Response;
      let text: string;
      try {
        res = await this.fetch(req, token);
        text = res.status === 204 ? '' : (await res.text()).slice(0, MAX_BODY);
      } catch (e) {
        const message =
          e instanceof Error && e.name === 'TimeoutError'
            ? 'Google không trả lời kịp'
            : 'Không kết nối được tới Google';
        await this.log(ctx, req, cost, {
          outcome: 'failed',
          errorCode: 'GOOGLE_NETWORK',
          message,
          durationMs: Date.now() - started,
        });
        if (attempt < attempts) {
          await sleep(this.config.GOOGLE_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new GoogleError(502, 'GOOGLE_NETWORK', message, 'network');
      }
      const durationMs = Date.now() - started;
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok || req.accept?.includes(res.status)) {
        await this.log(ctx, req, cost, { outcome: 'ok', httpStatus: res.status, durationMs });
        return { status: res.status, headers: res.headers, body: (body ?? {}) as T };
      }

      const kind = googleErrorKind(res.status, body);
      const message = googleErrorMessage(res.status, body);
      await this.log(ctx, req, cost, {
        outcome: 'failed',
        httpStatus: res.status,
        errorCode: googleErrorReason(body) ?? `HTTP_${res.status}`,
        message,
        durationMs,
      });

      if (kind === 'token' && req.auth.kind === 'connection' && !refreshed && req.host !== 'oauth') {
        // The access token may have been revoked or expired early: get a new one, once.
        this.tokens.delete(req.auth.connectionId);
        refreshed = true;
        attempt--;
        continue;
      }
      if (kind === 'quota') {
        const until = quotaResetAt(new Date());
        await this.block(ctx.tenantId, until);
        throw new GoogleError(
          429,
          'GOOGLE_QUOTA',
          `Google báo đã hết hạn mức YouTube trong ngày; MARIS chờ tới ${until.toISOString()}`,
          kind,
          until,
        );
      }
      if (kind === 'rate') {
        const retryAfter = Number(res.headers.get('retry-after'));
        const until = new Date(
          Date.now() + (retryAfter > 0 ? retryAfter * 1000 : RATE_BLOCK_MIN * 60_000),
        );
        await this.block(ctx.tenantId, until);
        throw new GoogleError(
          429,
          'GOOGLE_RATE_LIMITED',
          `Google đang giới hạn lượt gọi; MARIS tạm dừng tới ${until.toISOString()}`,
          kind,
          until,
        );
      }
      if (kind === 'upload_limit')
        throw new GoogleError(
          429,
          'YOUTUBE_UPLOAD_LIMIT',
          'Kênh đã tải lên tối đa số video YouTube cho phép trong 24 giờ; MARIS thử lại sau',
          kind,
          new Date(Date.now() + 6 * 3600_000),
        );
      if (kind === 'token') {
        if (req.auth.kind === 'connection')
          await this.markInvalid(ctx, req.auth.connectionId, message);
        throw new GoogleError(
          409,
          'GOOGLE_TOKEN_INVALID',
          `Quyền truy cập Google đã hết hiệu lực, cần kết nối lại (${message})`,
          kind,
        );
      }
      if (kind === 'permission')
        throw new GoogleError(
          409,
          'GOOGLE_PERMISSION',
          `Thiếu quyền trên Google: ${message}`,
          kind,
        );
      if (kind === 'transient' && attempt < attempts) {
        await sleep(this.config.GOOGLE_RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new GoogleError(
        res.status === 404 ? 404 : 502,
        res.status === 404 ? 'GOOGLE_NOT_FOUND' : 'GOOGLE_API_ERROR',
        `Google báo lỗi: ${message}`,
        kind,
      );
    }
  }

  /** Keeps an access token Google just gave (after sign-in), so the next calls use it. */
  remember(connectionId: string, token: string, expiresIn: number): void {
    this.tokens.set(connectionId, { token, exp: Date.now() + expiresIn * 1000 });
  }

  forget(connectionId: string): void {
    this.tokens.delete(connectionId);
  }

  /** Today's YouTube quota, as shown on the Google Center. */
  async quota(tx: Tx, tenantId: string): Promise<QuotaResponse> {
    const [app] = await tx.select().from(googleApps).where(eq(googleApps.tenantId, tenantId));
    const used = await this.usedToday(tx, tenantId);
    const s = quotaState(used, app?.youtubeQuota ?? 10_000);
    const blocked = await this.redis.client.get(`google:block:${tenantId}:youtube`);
    return {
      service: 'youtube',
      used: s.used,
      quota: s.quota,
      pct: s.pct,
      state: blocked ? 'blocked' : s.state,
      level: s.level,
      resetsAt: quotaResetAt(new Date()).toISOString(),
      blockedUntil: blocked,
    };
  }

  async usedToday(tx: Tx, tenantId: string): Promise<number> {
    const [{ n }] = await tx
      .select({ n: sql<number>`coalesce(sum(${apiCalls.units}), 0)::int` })
      .from(apiCalls)
      .where(
        and(
          eq(apiCalls.tenantId, tenantId),
          eq(apiCalls.provider, 'google'),
          ne(apiCalls.outcome, 'refused'),
          gte(apiCalls.createdAt, quotaDayStart(new Date())),
        ),
      );
    return n;
  }

  private async refusal(
    ctx: GoogleCtx,
    cost: number,
    priority: ApiPriority,
  ): Promise<GoogleError | null> {
    const blocked = await this.redis.client.get(`google:block:${ctx.tenantId}:youtube`);
    if (blocked)
      return new GoogleError(
        429,
        'GOOGLE_RATE_LIMITED',
        `Google đã yêu cầu tạm dừng; MARIS chờ tới ${blocked}`,
        'refused',
        new Date(blocked),
      );
    const { used, quota } = await this.db.withContext(ctx, async (tx) => {
      const [app] = await tx.select().from(googleApps).where(eq(googleApps.tenantId, ctx.tenantId));
      return { used: await this.usedToday(tx, ctx.tenantId), quota: app?.youtubeQuota ?? 10_000 };
    });
    const why = quotaRefusal(used, quota, cost, priority);
    return why
      ? new GoogleError(429, 'GOOGLE_QUOTA', why, 'refused', quotaResetAt(new Date()))
      : null;
  }

  private async block(tenantId: string, until: Date): Promise<void> {
    const ms = Math.max(1000, until.getTime() - Date.now());
    await this.redis.client.set(`google:block:${tenantId}:youtube`, until.toISOString(), 'PX', ms);
  }

  /** A valid access token for a connection, from memory or from its refresh token. */
  private async accessToken(ctx: GoogleCtx, connectionId: string): Promise<string> {
    const hit = this.tokens.get(connectionId);
    if (hit && hit.exp - TOKEN_MARGIN_MS > Date.now()) return hit.token;
    const { refresh, clientId, secret } = await this.db.withContext(ctx, async (tx) => {
      const [c] = await tx
        .select()
        .from(googleConnections)
        .where(
          and(eq(googleConnections.id, connectionId), eq(googleConnections.tenantId, ctx.tenantId)),
        );
      if (!c || c.status !== 'active' || !c.refreshTokenSealed)
        throw new GoogleError(
          409,
          'GOOGLE_NOT_CONNECTED',
          c && c.status !== 'removed'
            ? 'Kết nối Google đã hết hiệu lực, cần kết nối lại'
            : 'Chưa kết nối tài khoản Google',
        );
      const app = await this.app(tx, ctx.tenantId);
      return {
        refresh: this.vault.openFor(GOOGLE_TOKEN_SCOPE, ctx.tenantId, c.id, c.refreshTokenSealed),
        clientId: app.clientId,
        secret: app.secret,
      };
    });
    const r = await this.call<{ access_token?: string; expires_in?: number }>(ctx, {
      service: 'oauth',
      priority: 'essential',
      method: 'POST',
      host: 'oauth',
      path: '/token',
      auth: { kind: 'none' },
      form: {
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: clientId,
        client_secret: secret,
      },
    }).catch(async (e: unknown) => {
      // Google refused the refresh token (revoked, expired, password changed): reconnect.
      if (e instanceof GoogleError && e.kind === 'token')
        await this.markInvalid(ctx, connectionId, e.message);
      throw e;
    });
    if (!r.body.access_token)
      throw new GoogleError(502, 'GOOGLE_API_ERROR', 'Google không trả về mã truy cập');
    this.remember(connectionId, r.body.access_token, r.body.expires_in ?? 3600);
    return r.body.access_token;
  }

  /** The tenant's OAuth client with its secret from the vault. */
  async app(tx: Tx, tenantId: string) {
    const [app] = await tx.select().from(googleApps).where(eq(googleApps.tenantId, tenantId));
    if (!app)
      throw new GoogleError(
        409,
        'GOOGLE_APP_MISSING',
        'Chưa cài OAuth client Google. Vào Trung tâm Google để nhập Client ID.',
      );
    const secret = await this.vault.resolveByName(tx, tenantId, app.clientSecretName).catch(() => {
      throw new GoogleError(
        409,
        'GOOGLE_SECRET_MISSING',
        `Chưa có secret “${app.clientSecretName}” (Client secret của Google) trong Secret Vault`,
      );
    });
    return { ...app, secret };
  }

  private async markInvalid(ctx: GoogleCtx, connectionId: string, message: string): Promise<void> {
    this.tokens.delete(connectionId);
    await this.db.withContext(ctx, (tx) =>
      tx
        .update(googleConnections)
        .set({ status: 'invalid', checkError: message.slice(0, 500) })
        .where(and(eq(googleConnections.id, connectionId), eq(googleConnections.status, 'active'))),
    );
  }

  private hostUrl(host: GoogleRequest['host']): string {
    switch (host) {
      case 'oauth':
        return this.config.GOOGLE_OAUTH_URL;
      case 'analytics_data':
        return this.config.GOOGLE_ANALYTICS_DATA_URL;
      case 'analytics_admin':
        return this.config.GOOGLE_ANALYTICS_ADMIN_URL;
      case 'search_console':
        return this.config.GOOGLE_SEARCH_CONSOLE_URL;
      default:
        return this.config.GOOGLE_API_URL;
    }
  }

  private async fetch(req: GoogleRequest, token: string | null): Promise<Response> {
    const strip = (u: string) => u.replace(/\/$/, '');
    const url = req.sessionUrl
      ? new URL(req.sessionUrl)
      : new URL(`${strip(this.hostUrl(req.host))}${req.path}`);
    if (req.params)
      for (const [k, v] of Object.entries(req.params)) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | Blob | undefined;
    if (req.json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    } else if (req.body) body = req.body;
    return fetch(url, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_MS),
    });
  }

  private async log(
    ctx: GoogleCtx,
    req: GoogleRequest,
    units: number,
    r: {
      outcome: 'ok' | 'failed' | 'refused';
      httpStatus?: number;
      errorCode?: string;
      message?: string;
      durationMs?: number;
    },
  ): Promise<void> {
    await this.db.withContext(ctx, (tx) =>
      tx.insert(apiCalls).values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        provider: 'google',
        apiGroup: req.service,
        method: req.method,
        path: (req.sessionUrl ? '/upload/youtube/v3/videos (phiên tải lên)' : req.path).slice(
          0,
          300,
        ),
        outcome: r.outcome,
        httpStatus: r.httpStatus ?? null,
        errorCode: r.errorCode?.slice(0, 60) ?? null,
        errorMessage: r.message?.slice(0, 500) ?? null,
        durationMs: r.durationMs ?? null,
        units,
        googleChannelId: req.channelId ?? null,
        calledBy: ctx.userId,
      }),
    );
  }
}
