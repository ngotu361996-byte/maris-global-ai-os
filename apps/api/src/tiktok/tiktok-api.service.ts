import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { RedisService } from '../redis/redis.module';
import { SecretVaultService } from '../secrets/secret-vault.service';
import {
  tiktokErrorCode,
  tiktokErrorKind,
  tiktokErrorMessage,
  tiktokOk,
  type TiktokErrorKind,
} from './rules';

const { tiktokApps, tiktokAccounts, apiCalls } = schema;

export const TIKTOK_TOKEN_SCOPE = 'tiktok-refresh';

const TIMEOUT_MS = 30_000;
const MAX_BODY = 2 * 1024 * 1024;
/** Wait after TikTok says "too many requests" (its windows are one minute). */
const RATE_BLOCK_SEC = 60;
/** Refresh an access token (24 hours) this long before it runs out. */
const TOKEN_MARGIN_MS = 10 * 60_000;

export type TiktokAuth =
  | { kind: 'account'; accountId: string }
  | { kind: 'token'; token: string }
  | { kind: 'none' };

export interface TiktokRequest {
  /** What the call is for, for the call log. */
  group: 'oauth' | 'user' | 'post' | 'upload' | 'video';
  method: 'GET' | 'POST' | 'PUT';
  /** Starting with "/"; logged without the query string. */
  path?: string;
  params?: Record<string, string | number | boolean>;
  json?: unknown;
  form?: Record<string, string>;
  body?: Blob;
  headers?: Record<string, string>;
  /** A pre-signed upload address from TikTok, used instead of the API host (never logged). */
  uploadUrl?: string;
  auth: TiktokAuth;
  accountId?: string;
  timeoutMs?: number;
}

export interface TiktokResponse<T> {
  status: number;
  body: T;
}

export interface TiktokCtx {
  tenantId: string;
  userId: string | null;
}

export class TiktokError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly kind: TiktokErrorKind | 'network' | 'refused' = 'other',
    readonly retryAt: Date | null = null,
  ) {
    super({ code, message }, status);
  }
}

/**
 * TikTok sends post ids as 64-bit numbers, which JavaScript would round. They are read as text.
 */
export function bigIdsAsStrings(text: string): string {
  return text.replace(
    /("(?:publicaly|publicly)_available_post_id"\s*:\s*\[)([^\]]*)\]/g,
    (_m, head: string, list: string) =>
      `${head}${list.replace(/(^|,)\s*(-?\d+)\s*(?=,|$)/g, '$1"$2"')}]`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The managed gateway for every call to TikTok (spec Parts 15 and 17). It gets a fresh access
 * token from the sealed refresh token (keeping the new refresh token TikTok may send), stops calls
 * to an account for as long as TikTok asks, retries reads that failed for a passing reason, and
 * records every call. Tokens go in the Authorization header and are never logged; upload
 * addresses are pre-signed and get no token.
 */
@Injectable()
export class TiktokApiService {
  private readonly tokens = new Map<string, { token: string; exp: number }>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly vault: SecretVaultService,
  ) {}

  async call<T = Record<string, unknown>>(
    ctx: TiktokCtx,
    req: TiktokRequest,
  ): Promise<TiktokResponse<T>> {
    // TikTok's reads are POST too (video list, status); only they and GETs are safe to repeat.
    const repeatable =
      req.method === 'GET' ||
      (req.group === 'video' && req.method === 'POST') ||
      req.path === '/v2/post/publish/status/fetch/' ||
      req.path === '/v2/post/publish/creator_info/query/';
    const attempts = repeatable ? 3 : 1;
    const blockFor = req.accountId ?? (req.auth.kind === 'account' ? req.auth.accountId : null);
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      if (blockFor && req.group !== 'oauth') {
        const blocked = await this.redis.client.get(`tiktok:block:${ctx.tenantId}:${blockFor}`);
        if (blocked) {
          const e = new TiktokError(
            429,
            'TIKTOK_RATE_LIMITED',
            `TikTok đang giới hạn lượt gọi cho tài khoản này; MARIS chờ tới ${blocked}`,
            'refused',
            new Date(blocked),
          );
          await this.log(ctx, req, { outcome: 'refused', errorCode: e.code, message: e.message });
          throw e;
        }
      }
      const token =
        req.auth.kind === 'account'
          ? await this.accessToken(ctx, req.auth.accountId)
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
            ? 'TikTok không trả lời kịp'
            : 'Không kết nối được tới TikTok';
        await this.log(ctx, req, {
          outcome: 'failed',
          errorCode: 'TIKTOK_NETWORK',
          message,
          durationMs: Date.now() - started,
        });
        if (attempt < attempts) {
          await sleep(this.config.TIKTOK_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new TiktokError(502, 'TIKTOK_NETWORK', message, 'network');
      }
      const durationMs = Date.now() - started;
      let body: unknown = null;
      try {
        body = text ? JSON.parse(bigIdsAsStrings(text)) : null;
      } catch {
        body = null;
      }
      if (tiktokOk(res.status, body)) {
        await this.log(ctx, req, { outcome: 'ok', httpStatus: res.status, durationMs });
        return { status: res.status, body: (body ?? {}) as T };
      }

      const kind = tiktokErrorKind(res.status, body);
      const message = tiktokErrorMessage(res.status, body);
      const code = tiktokErrorCode(body);
      await this.log(ctx, req, {
        outcome: 'failed',
        httpStatus: res.status,
        errorCode: code ?? `HTTP_${res.status}`,
        message,
        durationMs,
      });

      if (kind === 'token' && req.auth.kind === 'account' && !refreshed) {
        // The access token may have been revoked or run out early: get a new one, once.
        this.tokens.delete(req.auth.accountId);
        refreshed = true;
        attempt--;
        continue;
      }
      if (kind === 'rate') {
        const until = new Date(Date.now() + RATE_BLOCK_SEC * 1000);
        if (blockFor) await this.block(ctx.tenantId, blockFor, until);
        throw new TiktokError(
          429,
          'TIKTOK_RATE_LIMITED',
          `TikTok đang giới hạn lượt gọi; MARIS tạm dừng tới ${until.toISOString()}`,
          kind,
          until,
        );
      }
      if (kind === 'post_limit')
        throw new TiktokError(
          429,
          'TIKTOK_POST_LIMIT',
          message,
          kind,
          new Date(Date.now() + 6 * 3600_000),
        );
      if (kind === 'token') {
        if (req.auth.kind === 'account') await this.markInvalid(ctx, req.auth.accountId, message);
        throw new TiktokError(
          409,
          'TIKTOK_TOKEN_INVALID',
          `Quyền truy cập TikTok đã hết hiệu lực, cần kết nối lại (${message})`,
          kind,
        );
      }
      if (kind === 'permission')
        throw new TiktokError(409, 'TIKTOK_PERMISSION', `Thiếu quyền trên TikTok: ${message}`, kind);
      if (kind === 'policy')
        throw new TiktokError(409, 'TIKTOK_POLICY', `TikTok không nhận: ${message}`, kind);
      if (kind === 'transient' && attempt < attempts) {
        await sleep(this.config.TIKTOK_RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new TiktokError(
        res.status === 404 ? 404 : 502,
        res.status === 404 ? 'TIKTOK_NOT_FOUND' : 'TIKTOK_API_ERROR',
        `TikTok báo lỗi: ${message}`,
        kind,
      );
    }
  }

  /** Keeps an access token TikTok just gave (after sign-in), so the next calls use it. */
  remember(accountId: string, token: string, expiresIn: number): void {
    this.tokens.set(accountId, { token, exp: Date.now() + expiresIn * 1000 });
  }

  forget(accountId: string): void {
    this.tokens.delete(accountId);
  }

  private async block(tenantId: string, accountId: string, until: Date): Promise<void> {
    const ms = Math.max(1000, until.getTime() - Date.now());
    await this.redis.client.set(
      `tiktok:block:${tenantId}:${accountId}`,
      until.toISOString(),
      'PX',
      ms,
    );
  }

  /** A valid access token for an account, from memory or from its refresh token. */
  private async accessToken(ctx: TiktokCtx, accountId: string): Promise<string> {
    const hit = this.tokens.get(accountId);
    if (hit && hit.exp - TOKEN_MARGIN_MS > Date.now()) return hit.token;
    const { refresh, clientKey, secret } = await this.db.withContext(ctx, async (tx) => {
      const [a] = await tx
        .select()
        .from(tiktokAccounts)
        .where(and(eq(tiktokAccounts.id, accountId), eq(tiktokAccounts.tenantId, ctx.tenantId)));
      if (!a || a.status !== 'active' || !a.refreshTokenSealed)
        throw new TiktokError(
          409,
          'TIKTOK_NOT_CONNECTED',
          a && a.status !== 'removed'
            ? 'Kết nối TikTok đã hết hiệu lực, cần kết nối lại'
            : 'Chưa kết nối tài khoản TikTok',
        );
      const app = await this.app(tx, ctx.tenantId);
      return {
        refresh: this.vault.openFor(TIKTOK_TOKEN_SCOPE, ctx.tenantId, a.id, a.refreshTokenSealed),
        clientKey: app.clientKey,
        secret: app.secret,
      };
    });
    const r = await this.call<{
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_expires_in?: number;
    }>(ctx, {
      group: 'oauth',
      method: 'POST',
      path: '/v2/oauth/token/',
      auth: { kind: 'none' },
      form: {
        client_key: clientKey,
        client_secret: secret,
        grant_type: 'refresh_token',
        refresh_token: refresh,
      },
    }).catch(async (e: unknown) => {
      // TikTok refused the refresh token (revoked, a year old): reconnect.
      if (e instanceof TiktokError && (e.kind === 'token' || e.kind === 'invalid'))
        await this.markInvalid(ctx, accountId, e.message);
      throw e;
    });
    if (!r.body.access_token)
      throw new TiktokError(502, 'TIKTOK_API_ERROR', 'TikTok không trả về mã truy cập');
    // TikTok may hand out a new refresh token; the old one then stops working.
    if (r.body.refresh_token && r.body.refresh_token !== refresh)
      await this.db.withContext(ctx, (tx) =>
        tx
          .update(tiktokAccounts)
          .set({
            refreshTokenSealed: this.vault.sealFor(
              TIKTOK_TOKEN_SCOPE,
              ctx.tenantId,
              accountId,
              r.body.refresh_token!,
            ),
            refreshExpiresAt: r.body.refresh_expires_in
              ? new Date(Date.now() + r.body.refresh_expires_in * 1000)
              : undefined,
          })
          .where(and(eq(tiktokAccounts.id, accountId), eq(tiktokAccounts.status, 'active'))),
      );
    this.remember(accountId, r.body.access_token, r.body.expires_in ?? 86_400);
    return r.body.access_token;
  }

  /** The tenant's TikTok app with its secret from the vault. */
  async app(tx: Tx, tenantId: string) {
    const [app] = await tx.select().from(tiktokApps).where(eq(tiktokApps.tenantId, tenantId));
    if (!app)
      throw new TiktokError(
        409,
        'TIKTOK_APP_MISSING',
        'Chưa cài ứng dụng TikTok. Vào Trung tâm TikTok để nhập Client key.',
      );
    const secret = await this.vault.resolveByName(tx, tenantId, app.clientSecretName).catch(() => {
      throw new TiktokError(
        409,
        'TIKTOK_SECRET_MISSING',
        `Chưa có secret “${app.clientSecretName}” (Client secret của TikTok) trong Secret Vault`,
      );
    });
    return { ...app, secret };
  }

  private async markInvalid(ctx: TiktokCtx, accountId: string, message: string): Promise<void> {
    this.tokens.delete(accountId);
    await this.db.withContext(ctx, (tx) =>
      tx
        .update(tiktokAccounts)
        .set({ status: 'invalid', checkError: message.slice(0, 500) })
        .where(and(eq(tiktokAccounts.id, accountId), eq(tiktokAccounts.status, 'active'))),
    );
  }

  private async fetch(req: TiktokRequest, token: string | null): Promise<Response> {
    const url = req.uploadUrl
      ? new URL(req.uploadUrl)
      : new URL(`${this.config.TIKTOK_API_URL.replace(/\/$/, '')}${req.path ?? '/'}`);
    if (req.params)
      for (const [k, v] of Object.entries(req.params)) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json', ...(req.headers ?? {}) };
    if (token && !req.uploadUrl) headers.Authorization = `Bearer ${token}`;
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
    ctx: TiktokCtx,
    req: TiktokRequest,
    r: {
      outcome: 'ok' | 'failed' | 'refused';
      httpStatus?: number;
      errorCode?: string;
      message?: string;
      durationMs?: number;
    },
  ): Promise<void> {
    const accountId = req.accountId ?? (req.auth.kind === 'account' ? req.auth.accountId : null);
    await this.db.withContext(ctx, (tx) =>
      tx.insert(apiCalls).values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        provider: 'tiktok',
        apiGroup: req.group,
        method: req.method,
        path: (req.uploadUrl ? '/upload (địa chỉ tải lên của TikTok)' : (req.path ?? '/')).slice(
          0,
          300,
        ),
        outcome: r.outcome,
        httpStatus: r.httpStatus ?? null,
        errorCode: r.errorCode?.slice(0, 60) ?? null,
        errorMessage: r.message?.slice(0, 500) ?? null,
        durationMs: r.durationMs ?? null,
        tiktokAccountId: accountId,
        calledBy: ctx.userId,
      }),
    );
  }
}
