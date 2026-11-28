import { HttpException, Inject, Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  API_GROUP_INFO,
  API_GROUPS,
  type ApiGroup,
  type ApiPriority,
  type GovernorGroupState,
  type GovernorResponse,
  type PlatformUsage,
} from '@maris/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { RedisService } from '../redis/redis.module';
import { SecretVaultService } from '../secrets/secret-vault.service';
import {
  allows,
  budgetsOf,
  cacheFactor,
  governorStatus,
  graphErrorKind,
  levelLabel,
  parseUsageHeaders,
  regainMinutes,
  usagePct,
  type GovernorStatus,
  type UsageDetail,
} from './governor';

const { metaApps, metaConnections, metaAssets, apiCalls } = schema;

/** How long Meta's usage headers count as current. */
const USAGE_FRESH_MS = 60 * 60_000;
/** Wait when Meta limits us without saying for how long. */
const DEFAULT_BLOCK_MIN = 60;
const CIRCUIT_FAILS = 5;
const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_OPEN_MS = 60_000;
const TIMEOUT_MS = 30_000;
const MAX_BODY = 2 * 1024 * 1024;

export const META_TOKEN_SCOPE = { user: 'meta-user', page: 'meta-page' } as const;

export type GraphAuth =
  | { kind: 'user' }
  | { kind: 'page'; assetId: string }
  | { kind: 'app' }
  | { kind: 'token'; token: string }
  | { kind: 'none' };

export interface GraphRequest {
  group: ApiGroup;
  priority: ApiPriority;
  method: 'GET' | 'POST' | 'DELETE';
  /** Without the version, starting with "/": "/me/accounts". */
  path: string;
  params?: Record<string, string | number | boolean>;
  auth: GraphAuth;
  /** Keep a GET answer this long and give it to every caller that asks again (Part 15 cache). */
  cacheSec?: number;
  assetId?: string;
  /** Which Meta host: the Graph API, its video upload host, or the resumable upload host. */
  host?: 'graph' | 'video' | 'upload';
  /** Files sent as multipart fields, streamed from disk. */
  files?: Record<string, { path: string; name: string; type: string }>;
  /** A file sent whole as the body to the upload host. The path may hold {v} for the version. */
  upload?: { path: string; size: number };
  timeoutMs?: number;
}

export interface GraphCtx {
  tenantId: string;
  userId: string | null;
}

interface Creds {
  version: string;
  appId: string | null;
  appSecret: string | null;
  token: string | null;
  connectionId: string | null;
  budgets: Partial<Record<string, number>>;
}

export class MetaError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly graphCode: number | null = null,
  ) {
    super({ code, message }, status);
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The managed gateway for every Meta Graph API call (spec Part 15). Before a call it checks
 * Meta's own stop orders, the circuit breaker and the internal daily budget of the call's API
 * group; it answers repeated reads from the cache and merges identical reads in flight; it reads
 * Meta's rate limit headers after each call, stops a group or all calls for as long as Meta asks,
 * retries reads that failed for a passing reason, and records every call it made or refused.
 */
@Injectable()
export class MetaGraphService {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly vault: SecretVaultService,
  ) {}

  async call<T = Record<string, unknown>>(ctx: GraphCtx, req: GraphRequest): Promise<T> {
    const creds = await this.db.withContext(ctx, (tx) => this.creds(tx, ctx.tenantId, req.auth));
    const params = { ...(req.params ?? {}) };
    if (creds.token && creds.appSecret && req.auth.kind !== 'app')
      params.appsecret_proof = createHmac('sha256', creds.appSecret)
        .update(creds.token)
        .digest('hex');

    const cacheKey =
      req.method === 'GET' && req.cacheSec
        ? `meta:cache:${ctx.tenantId}:${sha(
            JSON.stringify([req.path, Object.entries(req.params ?? {}).sort(), authKey(req.auth)]),
          )}`
        : null;
    if (cacheKey) {
      const hit = await this.redis.client.get(cacheKey);
      if (hit !== null) {
        await this.countCacheHit(ctx.tenantId);
        return JSON.parse(hit) as T;
      }
      const running = this.inflight.get(cacheKey);
      if (running) {
        await this.countCacheHit(ctx.tenantId);
        return running as Promise<T>;
      }
    }
    const run = this.send<T>(ctx, req, creds, params, cacheKey);
    if (cacheKey) {
      this.inflight.set(cacheKey, run);
      run.finally(() => this.inflight.delete(cacheKey)).catch(() => undefined);
    }
    return run;
  }

  /** The budget, Meta's last usage figures and any stop, as shown on the Meta Control Center. */
  async governor(tx: Tx, tenantId: string): Promise<GovernorResponse> {
    const [app] = await tx.select().from(metaApps).where(eq(metaApps.tenantId, tenantId));
    const status = await this.status(tx, tenantId, app?.budgets ?? {});
    const platform = await this.platformUsage(tenantId);
    const blocks = await this.blocks(tenantId);
    const hits = Number((await this.redis.client.get(`meta:cachehits:${tenantId}`)) ?? 0);
    return {
      windowHours: 24,
      used: status.used,
      budget: status.budget,
      pct: status.pct,
      level: levelLabel(status.levelPct),
      cacheHits: hits,
      groups: API_GROUPS.map((g) => {
        const s = status.groups[g];
        const until = blocks.all ?? blocks[g] ?? null;
        return {
          group: g,
          label: API_GROUP_INFO[g].label,
          used: s.used,
          budget: s.budget,
          pct: s.pct,
          state: (until ? 'blocked' : s.state) as GovernorGroupState,
          blockedUntil: until,
        };
      }),
      platform,
      blockedUntil: blocks.all ?? null,
    };
  }

  private async send<T>(
    ctx: GraphCtx,
    req: GraphRequest,
    creds: Creds,
    params: Record<string, string | number | boolean>,
    cacheKey: string | null,
  ): Promise<T> {
    const attempts = req.method === 'GET' ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      const status = await this.db.withContext(ctx, (tx) =>
        this.status(tx, ctx.tenantId, creds.budgets),
      );
      const refusal = await this.refusal(ctx.tenantId, req, status);
      if (refusal) {
        await this.log(ctx, req, {
          outcome: 'refused',
          errorCode: refusal.code,
          message: refusal.message,
        });
        throw refusal;
      }

      const started = Date.now();
      let res: Response;
      let text: string;
      try {
        res = await this.fetch(req, creds, params);
        text = (await res.text()).slice(0, MAX_BODY);
      } catch (e) {
        await this.failure(ctx.tenantId);
        const message =
          e instanceof Error && e.name === 'TimeoutError'
            ? 'Meta không trả lời kịp'
            : 'Không kết nối được tới Meta';
        await this.log(ctx, req, {
          outcome: 'failed',
          errorCode: 'META_NETWORK',
          message,
          durationMs: Date.now() - started,
        });
        if (attempt < attempts) {
          await sleep(this.config.META_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new MetaError(502, 'META_NETWORK', message);
      }
      const durationMs = Date.now() - started;
      const usage = parseUsageHeaders((n) => res.headers.get(n));
      if (usage.length) await this.saveUsage(ctx.tenantId, usage);

      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const err = (body as { error?: Record<string, unknown> } | null)?.error;
      if (res.ok && !err) {
        await this.success(ctx.tenantId);
        await this.log(ctx, req, { outcome: 'ok', httpStatus: res.status, durationMs, usage });
        if (cacheKey) {
          const ttl = req.cacheSec! * cacheFactor(status.levelPct);
          await this.redis.client.set(cacheKey, JSON.stringify(body ?? {}), 'EX', ttl);
        }
        return (body ?? {}) as T;
      }

      const code = typeof err?.code === 'number' ? err.code : null;
      const kind = graphErrorKind(code, err?.is_transient === true || res.status >= 500);
      const metaMessage = String(err?.message ?? `HTTP ${res.status}`).slice(0, 300);
      const errorCode =
        code !== null
          ? `GRAPH_${code}${err?.error_subcode ? `_${String(err.error_subcode)}` : ''}`
          : `HTTP_${res.status}`;
      await this.log(ctx, req, {
        outcome: 'failed',
        httpStatus: res.status,
        errorCode,
        message: metaMessage,
        durationMs,
        usage,
      });

      if (kind === 'rate_limited_app' || kind === 'rate_limited_scope') {
        const minutes = regainMinutes(usage) ?? DEFAULT_BLOCK_MIN;
        const until = await this.block(
          ctx.tenantId,
          kind === 'rate_limited_app' ? 'all' : req.group,
          minutes,
        );
        throw new MetaError(
          429,
          'META_RATE_LIMITED',
          `Meta đang giới hạn lượt gọi; MARIS tạm dừng ${kind === 'rate_limited_app' ? 'mọi lượt gọi' : `nhóm “${API_GROUP_INFO[req.group].label}”`} tới ${until}`,
          code,
        );
      }
      if (kind === 'token_invalid') {
        if (req.auth.kind === 'user' && creds.connectionId)
          await this.db.withContext(ctx, (tx) =>
            tx
              .update(metaConnections)
              .set({ status: 'invalid', checkError: metaMessage, checkedAt: new Date() })
              .where(eq(metaConnections.id, creds.connectionId!)),
          );
        throw new MetaError(
          409,
          'META_TOKEN_INVALID',
          `Quyền truy cập Facebook đã hết hiệu lực, cần kết nối lại (${metaMessage})`,
          code,
        );
      }
      if (kind === 'permission')
        throw new MetaError(
          409,
          'META_PERMISSION_MISSING',
          `Thiếu quyền trên Meta: ${metaMessage}`,
          code,
        );
      if (kind === 'transient' || res.status >= 500) {
        await this.failure(ctx.tenantId);
        if (attempt < attempts) {
          await sleep(this.config.META_RETRY_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
      }
      throw new MetaError(502, 'META_GRAPH_ERROR', `Meta báo lỗi: ${metaMessage}`, code);
    }
  }

  private async fetch(
    req: GraphRequest,
    creds: Creds,
    params: Record<string, string | number | boolean>,
  ): Promise<Response> {
    const host = req.host ?? 'graph';
    const strip = (u: string) => u.replace(/\/$/, '');
    const url =
      host === 'upload'
        ? new URL(`${strip(this.config.META_UPLOAD_URL)}${req.path.replace('{v}', creds.version)}`)
        : new URL(
            `${strip(host === 'video' ? this.config.META_GRAPH_VIDEO_URL : this.config.META_GRAPH_URL)}/${creds.version}${req.path}`,
          );
    const pairs = Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]);
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | FormData | Blob | undefined;
    if (req.upload) {
      // Meta's resumable upload host: the whole file in one request from offset 0.
      if (creds.token) headers.Authorization = `OAuth ${creds.token}`;
      headers.offset = '0';
      headers.file_size = String(req.upload.size);
      headers['Content-Type'] = 'application/octet-stream';
      body = await openAsBlob(req.upload.path);
    } else {
      if (creds.token) headers.Authorization = `Bearer ${creds.token}`;
      if (req.files) {
        const form = new FormData();
        for (const [k, v] of pairs) form.append(k, v);
        for (const [field, f] of Object.entries(req.files))
          form.append(field, await openAsBlob(f.path, { type: f.type }), f.name);
        body = form;
      } else if (req.method === 'POST') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(pairs).toString();
      } else url.search = new URLSearchParams(pairs).toString();
    }
    return fetch(url, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_MS),
    });
  }

  private async creds(tx: Tx, tenantId: string, auth: GraphAuth): Promise<Creds> {
    const [app] = await tx.select().from(metaApps).where(eq(metaApps.tenantId, tenantId));
    if (!app)
      throw new MetaError(
        409,
        'META_APP_MISSING',
        'Chưa cài Meta App. Vào Trung tâm Meta để nhập App ID.',
      );
    const appSecret = await this.vault.resolveByName(tx, tenantId, app.appSecretName).catch(() => {
      throw new MetaError(
        409,
        'META_APP_SECRET_MISSING',
        `Chưa có secret “${app.appSecretName}” (App Secret của Meta App) trong Secret Vault`,
      );
    });
    const creds: Creds = {
      version: app.graphVersion,
      appId: app.appId,
      appSecret,
      token: null,
      connectionId: null,
      budgets: app.budgets,
    };
    if (auth.kind === 'token') creds.token = auth.token;
    if (auth.kind === 'app') creds.token = `${app.appId}|${appSecret}`;
    if (auth.kind === 'user') {
      const [c] = await tx
        .select()
        .from(metaConnections)
        .where(and(eq(metaConnections.tenantId, tenantId), ne(metaConnections.status, 'removed')));
      if (!c?.tokenSealed || c.status !== 'active')
        throw new MetaError(
          409,
          'META_NOT_CONNECTED',
          c
            ? 'Kết nối Facebook đã hết hiệu lực, cần kết nối lại'
            : 'Chưa kết nối tài khoản Facebook',
        );
      creds.token = this.vault.openFor(META_TOKEN_SCOPE.user, tenantId, c.id, c.tokenSealed);
      creds.connectionId = c.id;
    }
    if (auth.kind === 'page') {
      const [a] = await tx
        .select()
        .from(metaAssets)
        .where(
          and(
            eq(metaAssets.id, auth.assetId),
            eq(metaAssets.tenantId, tenantId),
            eq(metaAssets.kind, 'page'),
            isNull(metaAssets.removedAt),
          ),
        );
      if (!a?.tokenSealed || !a.enabled)
        throw new MetaError(409, 'META_ASSET_OFF', 'Page chưa được bật trong Trung tâm Meta');
      creds.token = this.vault.openFor(META_TOKEN_SCOPE.page, tenantId, a.id, a.tokenSealed);
    }
    return creds;
  }

  private async status(
    tx: Tx,
    tenantId: string,
    overrides: Partial<Record<string, number>>,
  ): Promise<GovernorStatus> {
    const rows = await tx
      .select({ group: apiCalls.apiGroup, n: sql<number>`count(*)::int` })
      .from(apiCalls)
      .where(
        and(
          eq(apiCalls.tenantId, tenantId),
          eq(apiCalls.provider, 'meta'),
          ne(apiCalls.outcome, 'refused'),
          gt(apiCalls.createdAt, sql`now() - interval '24 hours'`),
        ),
      )
      .groupBy(apiCalls.apiGroup);
    const used: Partial<Record<ApiGroup, number>> = {};
    for (const r of rows)
      if ((API_GROUPS as readonly string[]).includes(r.group)) used[r.group as ApiGroup] = r.n;
    const platform = await this.platformUsage(tenantId);
    return governorStatus({
      budgets: budgetsOf(overrides),
      used,
      platformPct: platform.status === 'known' ? platform.pct : null,
    });
  }

  private async refusal(
    tenantId: string,
    req: GraphRequest,
    status: GovernorStatus,
  ): Promise<MetaError | null> {
    const blocks = await this.blocks(tenantId);
    const until = blocks.all ?? blocks[req.group];
    if (until)
      return new MetaError(
        429,
        'META_RATE_LIMITED',
        `Meta đã yêu cầu tạm dừng; MARIS chờ tới ${until}`,
      );
    if (await this.redis.client.exists(`meta:cb:open:${tenantId}`))
      return new MetaError(
        429,
        'META_CIRCUIT_OPEN',
        'Meta lỗi liên tục; MARIS tạm ngừng gọi trong 1 phút',
      );
    const s = status.groups[req.group];
    if (allows(s.state, req.priority)) return null;
    const label = API_GROUP_INFO[req.group].label;
    if (s.state === 'paused')
      return new MetaError(
        429,
        'META_BUDGET',
        `Nhóm “${label}” đã dùng gần hết hạn mức nội bộ trong 24 giờ (${s.used}/${s.budget}); tạm dừng`,
      );
    return new MetaError(
      429,
      'META_BUDGET',
      `Hạn mức API đã dùng ${Math.round(s.levelPct)}%; chỉ chạy việc ${s.state === 'essential_only' ? 'thiết yếu' : 'cần ngay'}, việc này để sau`,
    );
  }

  private async blocks(tenantId: string): Promise<Partial<Record<ApiGroup | 'all', string>>> {
    const keys = ['all', ...API_GROUPS] as const;
    const values = await this.redis.client.mget(...keys.map((k) => `meta:block:${tenantId}:${k}`));
    const out: Partial<Record<ApiGroup | 'all', string>> = {};
    keys.forEach((k, i) => {
      if (values[i]) out[k] = values[i]!;
    });
    return out;
  }

  private async block(tenantId: string, scope: ApiGroup | 'all', minutes: number): Promise<string> {
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    await this.redis.client.set(`meta:block:${tenantId}:${scope}`, until, 'PX', minutes * 60_000);
    return until;
  }

  private async saveUsage(tenantId: string, details: UsageDetail[]): Promise<void> {
    await this.redis.client.set(
      `meta:usage:${tenantId}`,
      JSON.stringify({ at: new Date().toISOString(), details }),
      'EX',
      7 * 24 * 3600,
    );
  }

  private async platformUsage(tenantId: string): Promise<PlatformUsage> {
    const raw = await this.redis.client.get(`meta:usage:${tenantId}`);
    if (!raw) return { status: 'unknown', pct: null, at: null, detail: [] };
    const { at, details } = JSON.parse(raw) as { at: string; details: UsageDetail[] };
    const fresh = Date.now() - Date.parse(at) < USAGE_FRESH_MS;
    return {
      status: fresh ? 'known' : 'stale',
      pct: usagePct(details),
      at,
      detail: details.map(({ regainMinutes: _r, ...d }) => d),
    };
  }

  private async countCacheHit(tenantId: string): Promise<void> {
    const key = `meta:cachehits:${tenantId}`;
    await this.redis.client
      .multi()
      .incr(key)
      .expire(key, 24 * 3600, 'NX')
      .exec();
  }

  private async failure(tenantId: string): Promise<void> {
    const key = `meta:cb:fail:${tenantId}`;
    const [[, n]] = (await this.redis.client
      .multi()
      .incr(key)
      .pexpire(key, CIRCUIT_WINDOW_MS, 'NX')
      .exec()) as [[unknown, number]];
    if (n >= CIRCUIT_FAILS)
      await this.redis.client
        .multi()
        .set(`meta:cb:open:${tenantId}`, '1', 'PX', CIRCUIT_OPEN_MS)
        .del(key)
        .exec();
  }

  private async success(tenantId: string): Promise<void> {
    await this.redis.client.del(`meta:cb:fail:${tenantId}`);
  }

  private async log(
    ctx: GraphCtx,
    req: GraphRequest,
    r: {
      outcome: 'ok' | 'failed' | 'refused';
      httpStatus?: number;
      errorCode?: string;
      message?: string;
      durationMs?: number;
      usage?: UsageDetail[];
    },
  ): Promise<void> {
    await this.db.withContext(ctx, (tx) =>
      tx.insert(apiCalls).values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        provider: 'meta',
        apiGroup: req.group,
        method: req.method,
        path: req.path.slice(0, 300),
        assetId: req.assetId ?? (req.auth.kind === 'page' ? req.auth.assetId : null),
        outcome: r.outcome,
        httpStatus: r.httpStatus ?? null,
        errorCode: r.errorCode ?? null,
        errorMessage: r.message?.slice(0, 500) ?? null,
        durationMs: r.durationMs ?? null,
        usage: r.usage?.length ? { headers: r.usage } : null,
        calledBy: ctx.userId,
      }),
    );
  }
}

function authKey(auth: GraphAuth): string {
  if (auth.kind === 'page') return `page:${auth.assetId}`;
  if (auth.kind === 'token') return `token:${sha(auth.token)}`;
  return auth.kind;
}
