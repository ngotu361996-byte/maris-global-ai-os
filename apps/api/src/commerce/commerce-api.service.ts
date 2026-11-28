import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { RedisService } from '../redis/redis.module';
import { SecretVaultService } from '../secrets/secret-vault.service';
import {
  grantedScopes,
  graphqlProblem,
  httpErrorKind,
  shopifyTokenMessage,
  throttleWaitSec,
  type CommerceErrorKind,
  type GraphqlError,
} from './rules';

const { commerceStores, apiCalls } = schema;
export type StoreRow = typeof commerceStores.$inferSelect;

const TIMEOUT_MS = 30_000;
const MAX_BODY = 8 * 1024 * 1024;
/** Wait after a store says "too many requests". */
const RATE_BLOCK_SEC = 60;
/** Get a new Shopify token (24 hours) this long before it runs out. */
const TOKEN_MARGIN_MS = 10 * 60_000;
/** How often a missing-access error may fetch a new token for the same store. */
const RESCOPE_MS = 5 * 60_000;

export interface CommerceCtx {
  tenantId: string;
  userId: string | null;
}

export type CommerceGroup = 'connect' | 'sync' | 'read' | 'write';

export class CommerceError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly kind: CommerceErrorKind | 'network' | 'refused' = 'other',
  ) {
    super({ code, message }, status);
  }
}

/** What the gateway needs to reach a store, before a store row exists (connecting) or after. */
export interface StoreTarget {
  /** Null while connecting. */
  id: string | null;
  platform: 'shopify' | 'poscake';
  externalId: string;
  clientId: string | null;
  secretName: string;
}

export interface ShopifyAnswer<T> {
  data: T;
  /** Field errors Shopify sent with the data (a field the app may not read). */
  warnings: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tokenKey = (t: StoreTarget) => t.id ?? `new:${t.externalId}:${t.clientId}`;

/**
 * The managed gateway for every call to Shopify and POSCake (spec Parts 15 and 18).
 * Shopify: a 24-hour Admin API token from the client credentials grant, kept in memory only and
 * sent in X-Shopify-Access-Token; throttled queries wait for Shopify's points to come back.
 * POSCake: the shop API key goes in the api_key query parameter, which is never logged.
 * A store that says "too many requests" is left alone for a minute; reads that failed for a
 * passing reason are tried again; every call is recorded.
 */
@Injectable()
export class CommerceApiService {
  private readonly tokens = new Map<string, { token: string; exp: number; scopes: string[] }>();
  private readonly rescoped = new Map<string, number>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly vault: SecretVaultService,
  ) {}

  /** The store's secret (Shopify Client secret or POSCake API key) from the vault. */
  async secret(tx: Tx, tenantId: string, name: string, platform: StoreTarget['platform']) {
    return this.vault.resolveByName(tx, tenantId, name).catch(() => {
      throw new CommerceError(
        409,
        'COMMERCE_SECRET_MISSING',
        `Chưa có secret “${name}” (${platform === 'shopify' ? 'Client secret của ứng dụng Shopify' : 'API key của POSCake'}) trong Secret Vault`,
      );
    });
  }

  private async secretFor(ctx: CommerceCtx, t: StoreTarget): Promise<string> {
    return this.db.withContext(ctx, (tx) => this.secret(tx, ctx.tenantId, t.secretName, t.platform));
  }

  forget(storeId: string): void {
    this.tokens.delete(storeId);
  }

  // ---------------------------------------------------------------------------------- Shopify

  private shopifyOrigin(domain: string): string {
    return this.config.SHOPIFY_ORIGIN
      ? `${this.config.SHOPIFY_ORIGIN.replace(/\/$/, '')}/${domain}`
      : `https://${domain}`;
  }

  /** A Shopify Admin API token for the store, and the scopes the store granted. */
  async shopifyToken(
    ctx: CommerceCtx,
    t: StoreTarget,
    fresh = false,
  ): Promise<{ token: string; scopes: string[] }> {
    const key = tokenKey(t);
    const hit = this.tokens.get(key);
    if (!fresh && hit && hit.exp - TOKEN_MARGIN_MS > Date.now()) return hit;
    const secret = await this.secretFor(ctx, t);
    const path = '/admin/oauth/access_token';
    const started = Date.now();
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.shopifyOrigin(t.externalId)}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: t.clientId ?? '',
          client_secret: secret,
        }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = (await res.text()).slice(0, MAX_BODY);
    } catch (e) {
      const message = this.networkMessage(e, 'Shopify');
      await this.log(ctx, t, 'connect', 'POST', path, {
        outcome: 'failed',
        errorCode: 'SHOPIFY_NETWORK',
        message,
        durationMs: Date.now() - started,
      });
      throw new CommerceError(502, 'SHOPIFY_NETWORK', message, 'network');
    }
    const body = parse(text) as {
      access_token?: string;
      scope?: string;
      expires_in?: number;
    } | null;
    if (!res.ok || !body?.access_token) {
      const message =
        res.status === 404
          ? `Không tìm thấy cửa hàng ${t.externalId} trên Shopify. Xem địa chỉ ...myshopify.com đúng trong trang quản trị Shopify: Cài đặt → Miền`
          : shopifyTokenMessage(body);
      await this.log(ctx, t, 'connect', 'POST', path, {
        outcome: 'failed',
        httpStatus: res.status,
        errorCode: 'SHOPIFY_TOKEN_REFUSED',
        message,
        durationMs: Date.now() - started,
      });
      if (t.id) await this.markInvalid(ctx, t.id, message);
      throw new CommerceError(
        res.status === 404 ? 404 : 409,
        'SHOPIFY_TOKEN_REFUSED',
        message,
        'auth',
      );
    }
    await this.log(ctx, t, 'connect', 'POST', path, {
      outcome: 'ok',
      httpStatus: res.status,
      durationMs: Date.now() - started,
    });
    const v = {
      token: body.access_token,
      scopes: grantedScopes(body.scope),
      exp: Date.now() + (body.expires_in ?? 86_399) * 1000,
    };
    this.tokens.set(key, v);
    return v;
  }

  /**
   * Shopify refused a field for missing access. The merchant may have approved new scopes since
   * the cached token was issued, so get a new token (at most every few minutes per store).
   * True when the new token carries different scopes.
   */
  private async rescope(ctx: CommerceCtx, t: StoreTarget): Promise<boolean> {
    const key = tokenKey(t);
    if (Date.now() - (this.rescoped.get(key) ?? 0) < RESCOPE_MS) return false;
    this.rescoped.set(key, Date.now());
    const before = this.tokens.get(key)?.scopes.join(',');
    const v = await this.shopifyToken(ctx, t, true);
    if (v.scopes.join(',') === before) return false;
    if (t.id) {
      const id = t.id;
      await this.db.withContext(ctx, (tx) =>
        tx.update(commerceStores).set({ scopes: v.scopes }).where(eq(commerceStores.id, id)),
      );
    }
    return true;
  }

  /** One Admin GraphQL request. `name` labels it in the call log. */
  async shopify<T>(
    ctx: CommerceCtx,
    t: StoreTarget,
    group: CommerceGroup,
    name: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<ShopifyAnswer<T>> {
    const path = `/admin/api/${this.config.SHOPIFY_API_VERSION}/graphql.json`;
    const logPath = `${path} ${name}`;
    const repeatable = group !== 'write';
    let refreshed = false;
    let rescoped = false;
    let throttles = 0;
    for (let attempt = 1; ; attempt++) {
      await this.checkBlock(ctx, t, group, 'POST', logPath);
      const { token } = await this.shopifyToken(ctx, t);
      const started = Date.now();
      let res: Response;
      let text: string;
      try {
        res = await fetch(`${this.shopifyOrigin(t.externalId)}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query, variables }),
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        text = (await res.text()).slice(0, MAX_BODY);
      } catch (e) {
        const message = this.networkMessage(e, 'Shopify');
        await this.log(ctx, t, group, 'POST', logPath, {
          outcome: 'failed',
          errorCode: 'SHOPIFY_NETWORK',
          message,
          durationMs: Date.now() - started,
        });
        if (repeatable && attempt < 3) {
          await sleep(this.config.COMMERCE_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new CommerceError(502, 'SHOPIFY_NETWORK', message, 'network');
      }
      const durationMs = Date.now() - started;
      const body = parse(text) as {
        data?: T;
        errors?: GraphqlError[] | string;
        extensions?: unknown;
      } | null;
      const errors = Array.isArray(body?.errors) ? body.errors : undefined;
      const problem = res.ok ? graphqlProblem(errors) : null;
      const denied = errors?.some((e) => e.extensions?.code === 'ACCESS_DENIED');
      if (denied && !rescoped) {
        rescoped = true;
        // Reads run again with the new token; a refused write was not applied, so it is left to the user.
        if ((await this.rescope(ctx, t)) && repeatable) {
          await this.log(ctx, t, group, 'POST', logPath, {
            outcome: 'failed',
            httpStatus: res.status,
            errorCode: 'SHOPIFY_RESCOPED',
            message: 'Shopify báo thiếu quyền; MARIS lấy mã mới với quyền vừa cấp và đọc lại',
            durationMs: Date.now() - started,
          });
          attempt--;
          continue;
        }
      }
      if (res.ok && body?.data && (!problem || problem.kind === 'invalid' || problem.kind === 'permission')) {
        // Data came back; field errors (a field the app may not read) are warnings.
        await this.log(ctx, t, group, 'POST', logPath, { outcome: 'ok', httpStatus: res.status, durationMs });
        return { data: body.data, warnings: (errors ?? []).map((e) => String(e.message ?? '')).slice(0, 5) };
      }
      const kind: CommerceErrorKind = problem?.kind ?? httpErrorKind(res.status);
      const message =
        problem?.message ??
        (typeof body?.errors === 'string' ? body.errors : null) ??
        `Shopify trả về HTTP ${res.status}`;
      await this.log(ctx, t, group, 'POST', logPath, {
        outcome: 'failed',
        httpStatus: res.status,
        errorCode: kind === 'rate' ? 'SHOPIFY_THROTTLED' : `HTTP_${res.status}`,
        message,
        durationMs,
      });
      if (kind === 'auth' && !refreshed) {
        // The token may have been revoked (app reinstalled, secret rotated): get a new one, once.
        this.tokens.delete(tokenKey(t));
        await this.shopifyToken(ctx, t, true);
        refreshed = true;
        attempt--;
        continue;
      }
      if (kind === 'rate') {
        // Throttled queries are not run, so they are safe to send again once points come back.
        if (problem && throttles < 3) {
          throttles++;
          attempt--;
          await sleep(throttleWaitSec(body?.extensions) * 1000);
          continue;
        }
        await this.block(ctx.tenantId, t, res.headers.get('retry-after'));
        throw new CommerceError(429, 'SHOPIFY_RATE_LIMITED', 'Shopify đang giới hạn lượt gọi; MARIS thử lại sau một phút', kind);
      }
      if (kind === 'auth') {
        if (t.id) await this.markInvalid(ctx, t.id, message);
        throw new CommerceError(409, 'SHOPIFY_AUTH', `Shopify không nhận mã truy cập: ${message}`, kind);
      }
      if (kind === 'transient' && repeatable && attempt < 3) {
        await sleep(this.config.COMMERCE_RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (kind === 'permission')
        throw new CommerceError(
          409,
          'SHOPIFY_PERMISSION',
          res.status === 402
            ? 'Cửa hàng Shopify đang bị khóa vì chưa thanh toán'
            : problem?.message ?? 'Ứng dụng thiếu quyền trên Shopify',
          kind,
        );
      throw new CommerceError(502, 'SHOPIFY_API_ERROR', `Shopify báo lỗi: ${message}`, kind);
    }
  }

  // ---------------------------------------------------------------------------------- POSCake

  /** One POSCake Open API request; paths start with "/". */
  async poscake<T>(
    ctx: CommerceCtx,
    t: StoreTarget,
    group: CommerceGroup,
    path: string,
    params: Record<string, string | number | (string | number)[]> = {},
  ): Promise<T> {
    const secret = await this.secretFor(ctx, t);
    for (let attempt = 1; ; attempt++) {
      await this.checkBlock(ctx, t, group, 'GET', path);
      const url = new URL(`${this.config.POSCAKE_API_URL.replace(/\/$/, '')}${path}`);
      for (const [k, v] of Object.entries(params)) {
        if (Array.isArray(v)) for (const x of v) url.searchParams.append(`${k}[]`, String(x));
        else url.searchParams.set(k, String(v));
      }
      url.searchParams.set('api_key', secret);
      const started = Date.now();
      let res: Response;
      let text: string;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        text = (await res.text()).slice(0, MAX_BODY);
      } catch (e) {
        const message = this.networkMessage(e, 'POSCake');
        await this.log(ctx, t, group, 'GET', path, {
          outcome: 'failed',
          errorCode: 'POSCAKE_NETWORK',
          message,
          durationMs: Date.now() - started,
        });
        if (attempt < 3) {
          await sleep(this.config.COMMERCE_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new CommerceError(502, 'POSCAKE_NETWORK', message, 'network');
      }
      const durationMs = Date.now() - started;
      const body = parse(text) as { success?: boolean; message?: unknown; error_code?: unknown } | null;
      if (res.ok && body && body.success !== false) {
        await this.log(ctx, t, group, 'GET', path, { outcome: 'ok', httpStatus: res.status, durationMs });
        return body as T;
      }
      let kind = httpErrorKind(res.status);
      if (res.ok && body?.success === false) kind = 'invalid';
      const said = typeof body?.message === 'string' ? body.message.slice(0, 300) : '';
      const message =
        kind === 'auth' || (res.status === 403 && !said)
          ? 'POSCake không nhận API key: tạo lại key trong Cấu hình → Nâng cao → Kết nối bên thứ 3 → Webhook/API'
          : said || `POSCake trả về HTTP ${res.status}`;
      await this.log(ctx, t, group, 'GET', path, {
        outcome: 'failed',
        httpStatus: res.status,
        errorCode: body?.error_code !== undefined ? `POSCAKE_${String(body.error_code).slice(0, 20)}` : `HTTP_${res.status}`,
        message,
        durationMs,
      });
      if (kind === 'rate') {
        await this.block(ctx.tenantId, t, res.headers.get('retry-after'));
        throw new CommerceError(429, 'POSCAKE_RATE_LIMITED', 'POSCake đang giới hạn lượt gọi; MARIS thử lại sau', kind);
      }
      if (kind === 'auth' || res.status === 403) {
        if (t.id) await this.markInvalid(ctx, t.id, message);
        throw new CommerceError(409, 'POSCAKE_AUTH', message, 'auth');
      }
      if (kind === 'transient' && attempt < 3) {
        await sleep(this.config.COMMERCE_RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new CommerceError(
        res.status === 404 ? 404 : 502,
        res.status === 404 ? 'POSCAKE_NOT_FOUND' : 'POSCAKE_API_ERROR',
        `POSCake báo lỗi: ${message}`,
        kind,
      );
    }
  }

  // ---------------------------------------------------------------------------------- shared

  private async checkBlock(
    ctx: CommerceCtx,
    t: StoreTarget,
    group: CommerceGroup,
    method: 'GET' | 'POST',
    path: string,
  ): Promise<void> {
    if (!t.id) return;
    const until = await this.redis.client.get(`commerce:block:${ctx.tenantId}:${t.id}`);
    if (!until) return;
    const message = `${t.platform === 'shopify' ? 'Shopify' : 'POSCake'} đang giới hạn lượt gọi cho cửa hàng này; MARIS chờ tới ${until}`;
    await this.log(ctx, t, group, method, path, {
      outcome: 'refused',
      errorCode: 'COMMERCE_RATE_LIMITED',
      message,
    });
    throw new CommerceError(429, 'COMMERCE_RATE_LIMITED', message, 'refused');
  }

  private async block(tenantId: string, t: StoreTarget, retryAfter: string | null): Promise<void> {
    if (!t.id) return;
    const sec = Math.min(600, Math.max(1, Number(retryAfter) || RATE_BLOCK_SEC));
    const until = new Date(Date.now() + sec * 1000).toISOString();
    await this.redis.client.set(`commerce:block:${tenantId}:${t.id}`, until, 'EX', sec);
  }

  private async markInvalid(ctx: CommerceCtx, storeId: string, message: string): Promise<void> {
    this.tokens.delete(storeId);
    await this.db.withContext(ctx, (tx) =>
      tx
        .update(commerceStores)
        .set({ status: 'invalid', checkError: message.slice(0, 500) })
        .where(and(eq(commerceStores.id, storeId), eq(commerceStores.status, 'active'))),
    );
  }

  private networkMessage(e: unknown, who: string): string {
    return e instanceof Error && e.name === 'TimeoutError'
      ? `${who} không trả lời kịp`
      : `Không kết nối được tới ${who}`;
  }

  private async log(
    ctx: CommerceCtx,
    t: StoreTarget,
    group: CommerceGroup,
    method: 'GET' | 'POST',
    path: string,
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
        provider: t.platform,
        apiGroup: group,
        method,
        path: path.slice(0, 300),
        outcome: r.outcome,
        httpStatus: r.httpStatus ?? null,
        errorCode: r.errorCode?.slice(0, 60) ?? null,
        errorMessage: r.message?.slice(0, 500) ?? null,
        durationMs: r.durationMs ?? null,
        commerceStoreId: t.id,
        calledBy: ctx.userId,
      }),
    );
  }
}

function parse(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The gateway target for a stored store. */
export function targetOf(s: StoreRow): StoreTarget {
  return {
    id: s.id,
    platform: s.platform,
    externalId: s.externalId,
    clientId: s.clientId,
    secretName: s.secretName,
  };
}
