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
  META_FEATURES,
  META_LIMITS,
  META_SCOPES,
  type ApiCallResponse,
  type MetaAssetResponse,
  type MetaCallback,
  type MetaConnectionResponse,
  type MetaOauthStartResponse,
  type MetaStatusResponse,
  type SetMetaApp,
  type UpdateMetaAsset,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { RedisService } from '../redis/redis.module';
import { SecretVaultService } from '../secrets/secret-vault.service';
import {
  META_TOKEN_SCOPE,
  MetaError,
  MetaGraphService,
  type GraphAuth,
} from './meta-graph.service';

const { metaApps, metaConnections, metaAssets, apiCalls, users, secrets } = schema;
type AssetRow = typeof metaAssets.$inferSelect;
type ConnectionRow = typeof metaConnections.$inferSelect;

const STATE_TTL_SEC = 600;
/** Pages of results read from one list (100 each), so a huge account cannot run the budget dry. */
const MAX_LIST_PAGES = 3;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface PageData {
  id: string;
  name?: string;
  category?: string;
  tasks?: string[];
  access_token?: string;
  instagram_business_account?: { id: string; username?: string; name?: string };
}
interface AdAccountData {
  id: string;
  name?: string;
  account_status?: number;
  currency?: string;
  timezone_name?: string;
}
interface ListPage<T> {
  data?: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/**
 * Meta Control Center (spec Part 14): the tenant's Meta App, the one Facebook account it signs in
 * with through Meta's own OAuth dialog, and the Pages, Instagram accounts and ad accounts that
 * account can use. Every call to Meta goes through MetaGraphService (the API Governor).
 */
@Injectable()
export class MetaService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly vault: SecretVaultService,
    private readonly graph: MetaGraphService,
    private readonly audit: AuditService,
  ) {}

  get redirectUri(): string {
    return `${this.config.WEB_ORIGIN.replace(/\/$/, '')}/meta/callback`;
  }

  async status(ctx: Ctx): Promise<MetaStatusResponse> {
    return this.db.withContext(ctx, (tx) => this.statusIn(tx, ctx.tenantId));
  }

  async setApp(ctx: Ctx, input: SetMetaApp): Promise<MetaStatusResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const values = {
        appId: input.appId,
        appSecretName: input.appSecretName,
        graphVersion: input.graphVersion,
        budgets: input.budgets as Record<string, number>,
        updatedBy: ctx.userId,
        updatedAt: new Date(),
      };
      await tx
        .insert(metaApps)
        .values({ tenantId: ctx.tenantId, ...values })
        .onConflictDoUpdate({ target: metaApps.tenantId, set: values });
      await this.log(tx, ctx, 'meta.app_set', null, {
        appId: input.appId,
        appSecretName: input.appSecretName,
        graphVersion: input.graphVersion,
        budgets: input.budgets,
      });
      return this.statusIn(tx, ctx.tenantId);
    });
  }

  /** The address of Meta's sign-in dialog, with a one-time state bound to this person and tenant. */
  async oauthStart(ctx: Ctx): Promise<MetaOauthStartResponse> {
    const app = await this.db.withContext(ctx, (tx) => this.appOf(tx, ctx.tenantId));
    const state = randomBytes(32).toString('base64url');
    await this.redis.client.set(
      `meta:oauth:${sha(state)}`,
      JSON.stringify({ tenantId: ctx.tenantId, userId: ctx.userId }),
      'EX',
      STATE_TTL_SEC,
    );
    const url = new URL(
      `${this.config.META_DIALOG_URL.replace(/\/$/, '')}/${app.graphVersion}/dialog/oauth`,
    );
    url.search = new URLSearchParams({
      client_id: app.appId,
      redirect_uri: this.redirectUri,
      state,
      response_type: 'code',
      scope: META_SCOPES.join(','),
    }).toString();
    return { url: url.toString() };
  }

  /**
   * Finishes sign-in: checks the state, trades the code for a long-lived token (about 60 days),
   * reads who signed in and what they allowed, stores the token sealed and syncs the assets.
   */
  async oauthCallback(ctx: Ctx, input: MetaCallback): Promise<MetaStatusResponse> {
    const saved = await this.redis.client.getdel(`meta:oauth:${sha(input.state)}`);
    const who = saved ? (JSON.parse(saved) as { tenantId: string; userId: string }) : null;
    if (!who || who.tenantId !== ctx.tenantId || who.userId !== ctx.userId)
      throw new BadRequestException({
        code: 'META_STATE_INVALID',
        message: 'Phiên đăng nhập Facebook không hợp lệ hoặc đã quá 10 phút. Bấm Kết nối lại.',
      });
    const { app, secret } = await this.db.withContext(ctx, async (tx) => {
      const app = await this.appOf(tx, ctx.tenantId);
      const secret = await this.vault.resolveByName(tx, ctx.tenantId, app.appSecretName);
      return { app, secret };
    });
    const g = { tenantId: ctx.tenantId, userId: ctx.userId };
    const short = await this.graph.call<{ access_token?: string }>(g, {
      group: 'sync',
      priority: 'essential',
      method: 'GET',
      path: '/oauth/access_token',
      auth: { kind: 'none' },
      params: {
        client_id: app.appId,
        client_secret: secret,
        redirect_uri: this.redirectUri,
        code: input.code,
      },
    });
    if (!short.access_token)
      throw new MetaError(502, 'META_GRAPH_ERROR', 'Meta không trả về mã truy cập');
    const long = await this.graph.call<{ access_token?: string; expires_in?: number }>(g, {
      group: 'sync',
      priority: 'essential',
      method: 'GET',
      path: '/oauth/access_token',
      auth: { kind: 'none' },
      params: {
        grant_type: 'fb_exchange_token',
        client_id: app.appId,
        client_secret: secret,
        fb_exchange_token: short.access_token,
      },
    });
    const token = long.access_token ?? short.access_token;
    const auth: GraphAuth = { kind: 'token', token };
    const me = await this.graph.call<{ id?: string; name?: string }>(g, {
      group: 'sync',
      priority: 'essential',
      method: 'GET',
      path: '/me',
      params: { fields: 'id,name' },
      auth,
    });
    if (!me.id || !/^[0-9]{1,30}$/.test(me.id))
      throw new MetaError(502, 'META_GRAPH_ERROR', 'Meta không cho biết tài khoản đã đăng nhập');
    const perms = await this.permissions(g, auth);
    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;

    await this.db.withContext(ctx, async (tx) => {
      const [current] = await tx
        .select()
        .from(metaConnections)
        .where(
          and(eq(metaConnections.tenantId, ctx.tenantId), ne(metaConnections.status, 'removed')),
        )
        .for('update');
      if (current && current.fbUserId !== me.id)
        throw new ConflictException({
          code: 'META_ONE_ACCOUNT',
          message: `Đã kết nối tài khoản Facebook “${current.fbName}”. Mỗi doanh nghiệp dùng một tài khoản; ngắt kết nối trước khi đổi.`,
        });
      const id = current?.id ?? uuidv7();
      const values = {
        fbName: (me.name ?? me.id!).slice(0, 200),
        tokenSealed: this.vault.sealFor(META_TOKEN_SCOPE.user, ctx.tenantId, id, token),
        tokenExpiresAt: expiresAt,
        scopes: perms.granted,
        declined: perms.declined,
        status: 'active' as const,
        checkError: null,
        connectedBy: ctx.userId,
        connectedAt: new Date(),
        checkedAt: new Date(),
      };
      if (current) await tx.update(metaConnections).set(values).where(eq(metaConnections.id, id));
      else
        await tx
          .insert(metaConnections)
          .values({ id, tenantId: ctx.tenantId, fbUserId: me.id!, ...values });
      await this.log(tx, ctx, 'meta.connected', id, {
        fbUserId: me.id,
        scopes: perms.granted,
        declined: perms.declined,
        reconnected: Boolean(current),
      });
    });
    await this.syncIn(ctx, 'essential');
    return this.status(ctx);
  }

  async sync(ctx: Ctx): Promise<MetaStatusResponse> {
    await this.syncIn(ctx, 'normal');
    return this.status(ctx);
  }

  /** Asks Meta whether the token still works and which permissions it carries (debug_token). */
  async check(ctx: Ctx): Promise<MetaStatusResponse> {
    const conn = await this.db.withContext(ctx, (tx) => this.connectionOf(tx, ctx.tenantId, true));
    const token = this.vault.openFor(
      META_TOKEN_SCOPE.user,
      ctx.tenantId,
      conn.id,
      conn.tokenSealed!,
    );
    const g = { tenantId: ctx.tenantId, userId: ctx.userId };
    const info = await this.graph.call<{
      data?: { is_valid?: boolean; expires_at?: number; error?: { message?: string } };
    }>(g, {
      group: 'sync',
      priority: 'normal',
      method: 'GET',
      path: '/debug_token',
      params: { input_token: token },
      auth: { kind: 'app' },
    });
    const d = info.data ?? {};
    const expiresAt = d.expires_at ? new Date(d.expires_at * 1000) : conn.tokenExpiresAt;
    let status: ConnectionRow['status'] = d.is_valid ? 'active' : 'invalid';
    if (!d.is_valid && expiresAt && expiresAt.getTime() < Date.now()) status = 'expired';
    const perms = status === 'active' ? await this.permissions(g, { kind: 'token', token }) : null;
    return this.db.withContext(ctx, async (tx) => {
      await tx
        .update(metaConnections)
        .set({
          status,
          tokenExpiresAt: expiresAt,
          checkedAt: new Date(),
          checkError:
            status === 'active'
              ? null
              : (d.error?.message ?? 'Token không còn hiệu lực').slice(0, 500),
          ...(perms ? { scopes: perms.granted, declined: perms.declined } : {}),
        })
        .where(eq(metaConnections.id, conn.id));
      await this.log(tx, ctx, 'meta.token_checked', conn.id, {
        status,
        scopes: perms?.granted ?? null,
      });
      return this.statusIn(tx, ctx.tenantId);
    });
  }

  async setAsset(ctx: Ctx, id: string, input: UpdateMetaAsset): Promise<MetaAssetResponse> {
    return this.db.withContext(ctx, async (tx) => {
      // One tenant at a time, so two people turning assets on cannot pass the limit together.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`meta-assets:${ctx.tenantId}`}))`,
      );
      const [a] = await tx
        .select()
        .from(metaAssets)
        .where(and(eq(metaAssets.id, id), eq(metaAssets.tenantId, ctx.tenantId)));
      if (!a)
        throw new NotFoundException({
          code: 'META_ASSET_NOT_FOUND',
          message: 'Không tìm thấy tài sản',
        });
      if (a.removedAt)
        throw new ConflictException({
          code: 'META_ASSET_REMOVED',
          message: 'Tài khoản Facebook không còn quyền với tài sản này',
        });
      if (input.enabled && !a.enabled) {
        const limit = a.kind === 'ad_account' ? META_LIMITS.adAccounts : META_LIMITS.pages;
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(metaAssets)
          .where(
            and(
              eq(metaAssets.tenantId, ctx.tenantId),
              eq(metaAssets.kind, a.kind),
              eq(metaAssets.enabled, true),
            ),
          );
        if (n >= limit)
          throw new ConflictException({
            code: 'META_ASSET_LIMIT',
            message: `Gói BUSINESS cho tối đa ${limit} ${KIND_LABEL[a.kind]}. Tắt một mục khác trước.`,
          });
      }
      const [row] = await tx
        .update(metaAssets)
        .set({ enabled: input.enabled })
        .where(eq(metaAssets.id, id))
        .returning();
      await this.log(tx, ctx, input.enabled ? 'meta.asset_enabled' : 'meta.asset_disabled', id, {
        kind: a.kind,
        externalId: a.externalId,
      });
      return assetResponse(row!);
    });
  }

  /**
   * Disconnects the account: tells Meta to drop this app's permissions (best effort, so a
   * token that already stopped working cannot block it) and erases every stored token.
   */
  async disconnect(ctx: Ctx): Promise<MetaStatusResponse> {
    const conn = await this.db.withContext(ctx, (tx) => this.connectionOf(tx, ctx.tenantId, false));
    let revoked = false;
    if (conn.status === 'active')
      revoked = await this.graph
        .call(
          { tenantId: ctx.tenantId, userId: ctx.userId },
          {
            group: 'sync',
            priority: 'essential',
            method: 'DELETE',
            path: '/me/permissions',
            auth: { kind: 'user' },
          },
        )
        .then(() => true)
        .catch(() => false);
    return this.db.withContext(ctx, async (tx) => {
      const now = new Date();
      await tx
        .update(metaConnections)
        .set({ status: 'removed', tokenSealed: null, removedAt: now })
        .where(eq(metaConnections.id, conn.id));
      await tx
        .update(metaAssets)
        .set({ enabled: false, tokenSealed: null, removedAt: now })
        .where(and(eq(metaAssets.tenantId, ctx.tenantId), isNull(metaAssets.removedAt)));
      await this.log(tx, ctx, 'meta.disconnected', conn.id, {
        fbUserId: conn.fbUserId,
        revokedAtMeta: revoked,
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
        .where(and(eq(apiCalls.tenantId, ctx.tenantId), eq(apiCalls.provider, 'meta')))
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

  private async syncIn(ctx: Ctx, priority: 'essential' | 'normal'): Promise<void> {
    const conn = await this.db.withContext(ctx, (tx) => this.connectionOf(tx, ctx.tenantId, true));
    const g = { tenantId: ctx.tenantId, userId: ctx.userId };
    const has = (s: string) => conn.scopes.includes(s);
    const pages = has('pages_show_list')
      ? await this.list<PageData>(g, priority, '/me/accounts', {
          fields:
            'id,name,category,tasks,access_token,instagram_business_account{id,username,name}',
        })
      : [];
    const ads =
      has('ads_read') || has('ads_management')
        ? await this.list<AdAccountData>(g, priority, '/me/adaccounts', {
            fields: 'id,name,account_status,currency,timezone_name',
          })
        : [];

    await this.db.withContext(ctx, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`meta-assets:${ctx.tenantId}`}))`,
      );
      const existing = await tx
        .select()
        .from(metaAssets)
        .where(eq(metaAssets.tenantId, ctx.tenantId));
      const byKey = new Map(existing.map((a) => [`${a.kind}:${a.externalId}`, a]));
      const enabledCount = { page: 0, instagram: 0, ad_account: 0 };
      for (const a of existing) if (a.enabled) enabledCount[a.kind]++;
      const seen = new Set<string>();
      const now = new Date();

      const upsert = async (
        kind: AssetRow['kind'],
        externalId: string,
        fields: Partial<AssetRow>,
        token: string | null,
        enableIfNew: boolean,
      ): Promise<string> => {
        const key = `${kind}:${externalId}`;
        seen.add(key);
        const old = byKey.get(key);
        const id = old?.id ?? uuidv7();
        const sealed = token
          ? this.vault.sealFor(META_TOKEN_SCOPE.page, ctx.tenantId, id, token)
          : null;
        const limit = kind === 'ad_account' ? META_LIMITS.adAccounts : META_LIMITS.pages;
        if (old) {
          const back = old.removedAt !== null;
          const enabled = back ? false : old.enabled;
          await tx
            .update(metaAssets)
            .set({
              ...fields,
              connectionId: conn.id,
              tokenSealed: sealed,
              removedAt: null,
              enabled,
              syncedAt: now,
            })
            .where(eq(metaAssets.id, id));
        } else {
          const enabled = enableIfNew && enabledCount[kind] < limit;
          if (enabled) enabledCount[kind]++;
          await tx.insert(metaAssets).values({
            id,
            tenantId: ctx.tenantId,
            connectionId: conn.id,
            kind,
            externalId,
            name: fields.name ?? externalId,
            ...fields,
            tokenSealed: sealed,
            enabled,
            syncedAt: now,
          });
        }
        return id;
      };

      for (const p of pages) {
        if (!/^[0-9]{1,30}$/.test(p.id)) continue;
        const pageId = await upsert(
          'page',
          p.id,
          {
            name: (p.name ?? p.id).slice(0, 300),
            category: p.category?.slice(0, 200) ?? null,
            tasks: p.tasks ?? [],
          },
          p.access_token ?? null,
          true,
        );
        const ig = p.instagram_business_account;
        if (ig && /^[0-9]{1,30}$/.test(ig.id)) {
          const pageOn = byKey.get(`page:${p.id}`)?.enabled ?? true;
          await upsert(
            'instagram',
            ig.id,
            {
              name: (ig.name ?? ig.username ?? ig.id).slice(0, 300),
              username: ig.username?.slice(0, 100) ?? null,
              pageId,
            },
            null,
            pageOn,
          );
        }
      }
      for (const a of ads) {
        if (!/^act_[0-9]{1,30}$/.test(a.id)) continue;
        await upsert(
          'ad_account',
          a.id,
          {
            name: (a.name ?? a.id).slice(0, 300),
            accountStatus: typeof a.account_status === 'number' ? a.account_status : null,
            currency: /^[A-Z]{3}$/.test(a.currency ?? '') ? a.currency! : null,
            timezone: a.timezone_name?.slice(0, 100) ?? null,
          },
          null,
          true,
        );
      }
      let removed = 0;
      for (const a of existing)
        if (!seen.has(`${a.kind}:${a.externalId}`) && !a.removedAt) {
          removed++;
          await tx
            .update(metaAssets)
            .set({ enabled: false, tokenSealed: null, removedAt: now })
            .where(eq(metaAssets.id, a.id));
        }
      await tx
        .update(metaConnections)
        .set({ syncedAt: now })
        .where(eq(metaConnections.id, conn.id));
      await this.log(tx, ctx, 'meta.synced', conn.id, {
        pages: pages.length,
        instagram: pages.filter((p) => p.instagram_business_account).length,
        adAccounts: ads.length,
        removed,
      });
    });
  }

  /** Reads a list page by page with the "after" cursor (Part 15 pagination control). */
  private async list<T>(
    g: { tenantId: string; userId: string },
    priority: 'essential' | 'normal',
    path: string,
    params: Record<string, string>,
  ): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let i = 0; i < MAX_LIST_PAGES; i++) {
      const page = await this.graph.call<ListPage<T>>(g, {
        group: 'sync',
        priority,
        method: 'GET',
        path,
        auth: { kind: 'user' },
        params: { ...params, limit: 100, ...(after ? { after } : {}) },
      });
      out.push(...(page.data ?? []));
      after = page.paging?.cursors?.after;
      if (!page.paging?.next || !after) break;
    }
    return out;
  }

  private async permissions(
    g: { tenantId: string; userId: string },
    auth: GraphAuth,
  ): Promise<{ granted: string[]; declined: string[] }> {
    const r = await this.graph.call<{ data?: { permission?: string; status?: string }[] }>(g, {
      group: 'sync',
      priority: 'essential',
      method: 'GET',
      path: '/me/permissions',
      auth,
    });
    const pick = (status: string) =>
      [
        ...new Set(
          (r.data ?? [])
            .filter((p) => p.status === status && p.permission)
            .map((p) => p.permission!),
        ),
      ]
        .filter((p) => /^[a-z_]{1,60}$/.test(p))
        .sort();
    return { granted: pick('granted'), declined: [...pick('declined'), ...pick('expired')] };
  }

  private async appOf(tx: Tx, tenantId: string) {
    const [app] = await tx.select().from(metaApps).where(eq(metaApps.tenantId, tenantId));
    if (!app)
      throw new ConflictException({
        code: 'META_APP_MISSING',
        message: 'Chưa cài Meta App. Nhập App ID và tên secret của App Secret trước.',
      });
    return app;
  }

  private async connectionOf(tx: Tx, tenantId: string, needToken: boolean): Promise<ConnectionRow> {
    const [c] = await tx
      .select()
      .from(metaConnections)
      .where(and(eq(metaConnections.tenantId, tenantId), ne(metaConnections.status, 'removed')));
    if (!c)
      throw new ConflictException({
        code: 'META_NOT_CONNECTED',
        message: 'Chưa kết nối tài khoản Facebook',
      });
    if (needToken && (c.status !== 'active' || !c.tokenSealed))
      throw new ConflictException({
        code: 'META_NOT_CONNECTED',
        message: 'Kết nối Facebook đã hết hiệu lực, cần kết nối lại',
      });
    return c;
  }

  private async statusIn(tx: Tx, tenantId: string): Promise<MetaStatusResponse> {
    const [app] = await tx.select().from(metaApps).where(eq(metaApps.tenantId, tenantId));
    const [secret] = app
      ? await tx
          .select({ id: secrets.id })
          .from(secrets)
          .where(
            and(
              eq(secrets.tenantId, tenantId),
              eq(secrets.name, app.appSecretName),
              isNull(secrets.deletedAt),
            ),
          )
      : [];
    const [conn] = await tx
      .select({ c: metaConnections, name: users.displayName })
      .from(metaConnections)
      .leftJoin(users, eq(users.id, metaConnections.connectedBy))
      .where(and(eq(metaConnections.tenantId, tenantId), ne(metaConnections.status, 'removed')));
    const assets = conn
      ? await tx
          .select()
          .from(metaAssets)
          .where(and(eq(metaAssets.tenantId, tenantId), eq(metaAssets.connectionId, conn.c.id)))
          .orderBy(asc(metaAssets.kind), asc(metaAssets.name))
      : [];
    const scopes = conn?.c.status === 'active' ? conn.c.scopes : [];
    return {
      app: app
        ? {
            appId: app.appId,
            appSecretName: app.appSecretName,
            secretFound: Boolean(secret),
            graphVersion: app.graphVersion,
            redirectUri: this.redirectUri,
            budgets: app.budgets,
          }
        : null,
      redirectUri: this.redirectUri,
      connection: conn ? connectionResponse(conn.c, conn.name) : null,
      features: META_FEATURES.map((f) => {
        const missing = f.scopes.filter((s) => !scopes.includes(s));
        return { key: f.key, label: f.label, ready: missing.length === 0, missing };
      }),
      assets: assets.map(assetResponse),
      governor: await this.graph.governor(tx, tenantId),
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
      targetType: 'meta',
      targetId,
      metadata,
      ip: ctx.ip,
    });
  }
}

const KIND_LABEL: Record<AssetRow['kind'], string> = {
  page: 'Page',
  instagram: 'tài khoản Instagram',
  ad_account: 'tài khoản quảng cáo',
};

function assetResponse(a: AssetRow): MetaAssetResponse {
  return {
    id: a.id,
    kind: a.kind,
    externalId: a.externalId,
    name: a.name,
    username: a.username,
    category: a.category,
    pageId: a.pageId,
    currency: a.currency,
    timezone: a.timezone,
    accountStatus: a.accountStatus,
    tasks: a.tasks,
    enabled: a.enabled,
    removed: a.removedAt !== null,
    syncedAt: a.syncedAt.toISOString(),
  };
}

function connectionResponse(c: ConnectionRow, name: string | null): MetaConnectionResponse {
  return {
    id: c.id,
    fbUserId: c.fbUserId,
    fbName: c.fbName,
    status: c.status as MetaConnectionResponse['status'],
    tokenExpiresAt: c.tokenExpiresAt?.toISOString() ?? null,
    scopes: c.scopes,
    declined: c.declined,
    checkError: c.checkError,
    connectedByName: name ?? '',
    connectedAt: c.connectedAt.toISOString(),
    checkedAt: c.checkedAt?.toISOString() ?? null,
    syncedAt: c.syncedAt?.toISOString() ?? null,
  };
}
