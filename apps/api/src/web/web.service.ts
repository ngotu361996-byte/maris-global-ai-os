import { HttpException, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  GOOGLE_SERVICES,
  WEB_LIMITS,
  WEB_TOP_KINDS,
  type CreateSite,
  type Ga4PropertyResponse,
  type GscSiteResponse,
  type UpdateSite,
  type WebCheckDetailResponse,
  type WebCheckResponse,
  type WebDayResponse,
  type WebGoogleAccount,
  type WebReportResponse,
  type WebSiteResponse,
  type WebStatusResponse,
  type WebSyncResponse,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { GoogleApiService } from '../google/google-api.service';
import { isoDay, lastDays } from './rules';
import { WebCheckService } from './web-check.service';
import { WebSyncService, type SiteRow } from './web-sync.service';

const { webSites, webGa4Daily, webGscDaily, webTops, webChecks, webCheckIssues, googleConnections, users } =
  schema;

type CheckRow = typeof webChecks.$inferSelect;

const ANALYTICS_SCOPE = GOOGLE_SERVICES.analytics.scopes[0]!;
const GSC_SCOPE = GOOGLE_SERVICES.search_console.scopes[0]!;
/** A check still "running" after this long was cut off (the API restarted). */
const STALE_CHECK_MS = 30 * 60_000;

const fail = (status: number, code: string, message: string) => new HttpException({ code, message }, status);

/**
 * Website and SEO Center (spec Parts 16 and 18, M21). Reading needs web.read; adding, linking,
 * removing sites, reading now and running a check need web.manage. GA4 and Search Console are read
 * through a Google account on the Google Center; MARIS never changes anything on Google.
 */
@Injectable()
export class WebService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly google: GoogleApiService,
    private readonly syncer: WebSyncService,
    private readonly checker: WebCheckService,
  ) {}

  async status(ctx: Ctx): Promise<WebStatusResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const conns = await tx
        .select()
        .from(googleConnections)
        .where(and(eq(googleConnections.tenantId, ctx.tenantId), eq(googleConnections.status, 'active')))
        .orderBy(asc(googleConnections.email));
      const accounts: WebGoogleAccount[] = conns.map((c) => ({
        id: c.id,
        email: c.email,
        analytics: c.scopes.includes(ANALYTICS_SCOPE),
        searchConsole: c.scopes.includes(GSC_SCOPE),
      }));
      return {
        sites: await this.sitesIn(tx, ctx.tenantId),
        accounts,
        syncEveryHours: this.config.WEB_SYNC_HOURS,
      };
    });
  }

  async create(ctx: Ctx, input: CreateSite): Promise<WebSiteResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const live = await tx
        .select({ id: webSites.id, url: webSites.url })
        .from(webSites)
        .where(and(eq(webSites.tenantId, ctx.tenantId), isNull(webSites.removedAt)));
      if (live.some((s) => s.url === input.url))
        throw fail(409, 'WEB_SITE_EXISTS', 'Website này đã có trong danh sách');
      if (live.length >= WEB_LIMITS.sites)
        throw fail(409, 'WEB_SITE_LIMIT', `Tối đa ${WEB_LIMITS.sites} website`);
      const id = uuidv7();
      await tx.insert(webSites).values({
        id,
        tenantId: ctx.tenantId,
        name: input.name,
        url: input.url,
        createdBy: ctx.userId,
      });
      await this.log(tx, ctx, 'web.site_created', id, { name: input.name, url: input.url });
      return this.siteOut(tx, ctx.tenantId, id);
    });
  }

  async update(ctx: Ctx, id: string, input: UpdateSite): Promise<WebSiteResponse> {
    // Check what the account can read before writing anything.
    let ga4Name: string | null = null;
    if (input.ga4) {
      await this.connection(ctx, input.ga4.connectionId, ANALYTICS_SCOPE, 'Google Analytics 4');
      const props = await this.ga4Properties(ctx, input.ga4.connectionId);
      const p = props.find((x) => x.property === input.ga4!.property);
      if (!p) throw fail(404, 'WEB_GA4_NOT_FOUND', 'Tài khoản Google này không xem được thuộc tính GA4 đó');
      ga4Name = p.name.slice(0, 200);
    }
    if (input.gsc) {
      await this.connection(ctx, input.gsc.connectionId, GSC_SCOPE, 'Search Console');
      const sites = await this.gscSites(ctx, input.gsc.connectionId);
      if (!sites.some((s) => s.site === input.gsc!.site))
        throw fail(404, 'WEB_GSC_NOT_FOUND', 'Tài khoản Google này không có thuộc tính Search Console đó');
    }
    return this.db.withContext(ctx, async (tx) => {
      const site = await this.site(tx, ctx.tenantId, id);
      const set: Partial<typeof webSites.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.enabled !== undefined) set.enabled = input.enabled;
      if (input.ga4 !== undefined) {
        set.ga4Property = input.ga4?.property ?? null;
        set.ga4ConnectionId = input.ga4?.connectionId ?? null;
        set.ga4Name = input.ga4 ? ga4Name : null;
      }
      if (input.gsc !== undefined) {
        set.gscSite = input.gsc?.site ?? null;
        set.gscConnectionId = input.gsc?.connectionId ?? null;
        if (!input.gsc) set.gscSitemaps = [];
      }
      // A new property starts with its own numbers.
      if (input.ga4 !== undefined && input.ga4?.property !== site.ga4Property) {
        await tx.delete(webTops).where(and(eq(webTops.siteId, id), inArray(webTops.kind, ['ga4_page', 'ga4_channel'])));
        await tx.delete(webGa4Daily).where(eq(webGa4Daily.siteId, id));
      }
      if (input.gsc !== undefined && input.gsc?.site !== site.gscSite) {
        await tx.delete(webTops).where(and(eq(webTops.siteId, id), inArray(webTops.kind, ['gsc_query', 'gsc_page'])));
        await tx.delete(webGscDaily).where(eq(webGscDaily.siteId, id));
      }
      await tx.update(webSites).set(set).where(eq(webSites.id, id));
      await this.log(tx, ctx, 'web.site_updated', id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.ga4 !== undefined ? { ga4: input.ga4?.property ?? null } : {}),
        ...(input.gsc !== undefined ? { gsc: input.gsc?.site ?? null } : {}),
      });
      return this.siteOut(tx, ctx.tenantId, id);
    });
  }

  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.withContext(ctx, async (tx) => {
      const site = await this.site(tx, ctx.tenantId, id);
      await tx
        .update(webSites)
        .set({ removedAt: new Date(), enabled: false })
        .where(eq(webSites.id, id));
      await this.log(tx, ctx, 'web.site_removed', id, { url: site.url });
    });
  }

  // ------------------------------------------------------------------------- Google lists

  async ga4Properties(ctx: Ctx, connectionId: string): Promise<Ga4PropertyResponse[]> {
    await this.connection(ctx, connectionId, ANALYTICS_SCOPE, 'Google Analytics 4');
    const out: Ga4PropertyResponse[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.google.call<{
        accountSummaries?: {
          displayName?: string;
          propertySummaries?: { property?: string; displayName?: string }[];
        }[];
        nextPageToken?: string;
      }>(ctx, {
        service: 'analytics',
        priority: 'essential',
        method: 'GET',
        host: 'analytics_admin',
        path: '/v1beta/accountSummaries',
        params: { pageSize: 200, ...(pageToken ? { pageToken } : {}) },
        auth: { kind: 'connection', connectionId },
      });
      for (const a of r.body.accountSummaries ?? [])
        for (const p of a.propertySummaries ?? [])
          if (p.property && /^properties\/[0-9]{1,20}$/.test(p.property))
            out.push({ property: p.property, name: p.displayName ?? p.property, account: a.displayName ?? '' });
      pageToken = r.body.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return out;
  }

  async gscSites(ctx: Ctx, connectionId: string): Promise<GscSiteResponse[]> {
    await this.connection(ctx, connectionId, GSC_SCOPE, 'Search Console');
    const r = await this.google.call<{ siteEntry?: { siteUrl?: string; permissionLevel?: string }[] }>(ctx, {
      service: 'search_console',
      priority: 'essential',
      method: 'GET',
      host: 'search_console',
      path: '/webmasters/v3/sites',
      auth: { kind: 'connection', connectionId },
    });
    return (r.body.siteEntry ?? [])
      .filter((s) => s.siteUrl && s.permissionLevel !== 'siteUnverifiedUser')
      .map((s) => ({ site: s.siteUrl!, permission: s.permissionLevel ?? '' }))
      .sort((a, b) => a.site.localeCompare(b.site));
  }

  // --------------------------------------------------------------------------------- reading

  async sync(ctx: Ctx, id?: string): Promise<WebSyncResponse> {
    const sites = await this.db.withContext(ctx, async (tx) =>
      id
        ? [await this.site(tx, ctx.tenantId, id)]
        : tx
            .select()
            .from(webSites)
            .where(
              and(eq(webSites.tenantId, ctx.tenantId), isNull(webSites.removedAt), eq(webSites.enabled, true)),
            ),
    );
    const linked = sites.filter((s) => s.ga4Property || s.gscSite);
    if (id && !linked.length)
      throw fail(409, 'WEB_NOT_LINKED', 'Website chưa liên kết Google Analytics 4 hay Search Console');
    const out: WebSyncResponse = { sites: 0, days: 0, errors: [] };
    for (const s of linked) {
      try {
        const r = await this.syncer.syncSite(ctx, s);
        out.sites++;
        out.days += r.days;
        out.errors.push(...r.errors.map((e) => (id ? e : `${s.name}: ${e}`)));
      } catch (e) {
        if (id) throw e;
        out.errors.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  async report(ctx: Ctx, siteId: string, days: number): Promise<WebReportResponse> {
    return this.db.withContext(ctx, async (tx) => {
      await this.site(tx, ctx.tenantId, siteId);
      const now = new Date();
      const cur = lastDays(now, days);
      const prevTo = new Date(Date.parse(`${cur.from}T00:00:00Z`) - 86_400_000);
      const prev = lastDays(new Date(prevTo.getTime() + 86_400_000), days);

      const ga4 = await tx
        .select()
        .from(webGa4Daily)
        .where(and(eq(webGa4Daily.siteId, siteId), gte(webGa4Daily.day, prev.from), lte(webGa4Daily.day, cur.to)))
        .orderBy(asc(webGa4Daily.day));
      const gsc = await tx
        .select()
        .from(webGscDaily)
        .where(and(eq(webGscDaily.siteId, siteId), gte(webGscDaily.day, prev.from), lte(webGscDaily.day, cur.to)))
        .orderBy(asc(webGscDaily.day));
      const inCur = (d: string) => d >= cur.from && d <= cur.to;
      const ga4Cur = ga4.filter((r) => inCur(r.day));
      const gscCur = gsc.filter((r) => inCur(r.day));
      const ga4Prev = ga4.filter((r) => !inCur(r.day));
      const gscPrev = gsc.filter((r) => !inCur(r.day));
      const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);

      const sessions = sum(ga4Cur, (r) => r.sessions);
      const clicks = sum(gscCur, (r) => r.clicks);
      const impressions = sum(gscCur, (r) => r.impressions);
      const engaged = sum(ga4Cur, (r) => r.sessions * Number(r.engagementRate));
      const posWeighted = sum(gscCur, (r) => r.impressions * Number(r.position));

      const byDay = new Map<string, WebDayResponse>();
      for (let t = Date.parse(`${cur.from}T00:00:00Z`); t <= Date.parse(`${cur.to}T00:00:00Z`); t += 86_400_000) {
        const day = isoDay(new Date(t));
        byDay.set(day, {
          day,
          sessions: null,
          users: null,
          views: null,
          keyEvents: null,
          clicks: null,
          impressions: null,
          position: null,
        });
      }
      for (const r of ga4Cur) {
        const d = byDay.get(r.day);
        if (d) Object.assign(d, { sessions: r.sessions, users: r.users, views: r.views, keyEvents: Number(r.keyEvents) });
      }
      for (const r of gscCur) {
        const d = byDay.get(r.day);
        if (d) Object.assign(d, { clicks: r.clicks, impressions: r.impressions, position: Number(r.position) });
      }

      const topRows = await tx
        .select()
        .from(webTops)
        .where(eq(webTops.siteId, siteId))
        .orderBy(asc(webTops.kind), asc(webTops.rank));
      const tops = Object.fromEntries(WEB_TOP_KINDS.map((k) => [k, [] as WebReportResponse['tops'][typeof k]])) as WebReportResponse['tops'];
      for (const r of topRows)
        tops[r.kind].push({ key: r.key, a: Number(r.a), b: Number(r.b), c: Number(r.c), d: Number(r.d) });

      return {
        siteId,
        days,
        totals: {
          sessions,
          users: sum(ga4Cur, (r) => r.users),
          newUsers: sum(ga4Cur, (r) => r.newUsers),
          views: sum(ga4Cur, (r) => r.views),
          keyEvents: Math.round(sum(ga4Cur, (r) => Number(r.keyEvents)) * 100) / 100,
          engagementRate: sessions ? Math.round((engaged / sessions) * 10_000) / 10_000 : null,
          clicks,
          impressions,
          ctr: impressions ? Math.round((clicks / impressions) * 10_000) / 10_000 : null,
          position: impressions ? Math.round((posWeighted / impressions) * 10) / 10 : null,
        },
        before: {
          sessions: sum(ga4Prev, (r) => r.sessions),
          clicks: sum(gscPrev, (r) => r.clicks),
          impressions: sum(gscPrev, (r) => r.impressions),
          keyEvents: Math.round(sum(ga4Prev, (r) => Number(r.keyEvents)) * 100) / 100,
        },
        daily: [...byDay.values()],
        tops,
      };
    });
  }

  // ---------------------------------------------------------------------------------- checks

  async startCheck(ctx: Ctx, siteId: string): Promise<WebCheckResponse> {
    const { site, check } = await this.db.withContext(ctx, async (tx) => {
      const site = await this.site(tx, ctx.tenantId, siteId);
      if (this.checker.isRunning(site.id))
        throw fail(409, 'WEB_CHECK_RUNNING', 'Đang kiểm tra website này, chờ xong rồi chạy lại');
      // A check left running by a restart is closed first.
      await tx
        .update(webChecks)
        .set({ status: 'failed', error: 'Bị ngắt giữa chừng (máy chủ khởi động lại)', finishedAt: new Date() })
        .where(and(eq(webChecks.siteId, site.id), eq(webChecks.status, 'running')));
      const id = uuidv7();
      await tx.insert(webChecks).values({
        id,
        tenantId: ctx.tenantId,
        siteId: site.id,
        status: 'running',
        requestedBy: ctx.userId,
      });
      await this.log(tx, ctx, 'web.check_started', site.id, { checkId: id, url: site.url });
      const [check] = await tx.select().from(webChecks).where(eq(webChecks.id, id));
      return { site, check: check! };
    });
    void this.checker.run({ tenantId: ctx.tenantId, userId: ctx.userId }, site, check.id);
    return this.db.withContext(ctx, async (tx) => (await this.checksOut(tx, [check]))[0]!);
  }

  async checks(ctx: Ctx, siteId: string): Promise<WebCheckResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.site(tx, ctx.tenantId, siteId);
      const rows = await tx
        .select()
        .from(webChecks)
        .where(eq(webChecks.siteId, siteId))
        .orderBy(desc(webChecks.startedAt))
        .limit(20);
      return this.checksOut(tx, rows);
    });
  }

  async check(ctx: Ctx, id: string): Promise<WebCheckDetailResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const [row] = await tx
        .select()
        .from(webChecks)
        .where(and(eq(webChecks.id, id), eq(webChecks.tenantId, ctx.tenantId)));
      if (!row) throw fail(404, 'WEB_CHECK_NOT_FOUND', 'Không tìm thấy lần kiểm tra');
      const issues = await tx
        .select()
        .from(webCheckIssues)
        .where(eq(webCheckIssues.checkId, id))
        .orderBy(asc(webCheckIssues.severity), asc(webCheckIssues.kind), asc(webCheckIssues.url));
      const [out] = await this.checksOut(tx, [row]);
      return {
        ...out!,
        issues: issues.map((i) => ({ severity: i.severity, kind: i.kind, url: i.url, detail: i.detail })),
      };
    });
  }

  // --------------------------------------------------------------------------------- helpers

  private async connection(ctx: Ctx, id: string, scope: string, label: string): Promise<void> {
    const [c] = await this.db.withContext(ctx, (tx) =>
      tx
        .select()
        .from(googleConnections)
        .where(and(eq(googleConnections.id, id), eq(googleConnections.tenantId, ctx.tenantId))),
    );
    if (!c || c.status === 'removed') throw fail(404, 'GOOGLE_NOT_CONNECTED', 'Không tìm thấy tài khoản Google');
    if (c.status !== 'active')
      throw fail(409, 'GOOGLE_NOT_CONNECTED', 'Kết nối Google đã hết hiệu lực, cần kết nối lại ở Trung tâm Google');
    if (!c.scopes.includes(scope))
      throw fail(
        409,
        'GOOGLE_SCOPE_MISSING',
        `Tài khoản ${c.email} chưa cấp quyền ${label}. Vào Trung tâm Google, kết nối lại và đánh dấu ${label}.`,
      );
  }

  private async site(tx: Tx, tenantId: string, id: string): Promise<SiteRow> {
    const [s] = await tx
      .select()
      .from(webSites)
      .where(and(eq(webSites.id, id), eq(webSites.tenantId, tenantId), isNull(webSites.removedAt)));
    if (!s) throw fail(404, 'WEB_SITE_NOT_FOUND', 'Không tìm thấy website');
    return s;
  }

  private async siteOut(tx: Tx, tenantId: string, id: string): Promise<WebSiteResponse> {
    const all = await this.sitesIn(tx, tenantId, id);
    return all[0]!;
  }

  private async sitesIn(tx: Tx, tenantId: string, only?: string): Promise<WebSiteResponse[]> {
    const rows = await tx
      .select({ s: webSites, by: users.displayName })
      .from(webSites)
      .innerJoin(users, eq(users.id, webSites.createdBy))
      .where(
        and(eq(webSites.tenantId, tenantId), isNull(webSites.removedAt), ...(only ? [eq(webSites.id, only)] : [])),
      )
      .orderBy(asc(webSites.name));
    if (!rows.length) return [];
    const conns = await tx
      .select({ id: googleConnections.id, email: googleConnections.email })
      .from(googleConnections)
      .where(eq(googleConnections.tenantId, tenantId));
    const email = new Map(conns.map((c) => [c.id, c.email]));
    const ids = rows.map((r) => r.s.id);
    const latest = await tx
      .selectDistinctOn([webChecks.siteId])
      .from(webChecks)
      .where(inArray(webChecks.siteId, ids))
      .orderBy(webChecks.siteId, desc(webChecks.startedAt));
    const checks = new Map((await this.checksOut(tx, latest)).map((c) => [c.siteId, c]));
    return rows.map(({ s, by }) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      enabled: s.enabled,
      ga4:
        s.ga4Property && s.ga4ConnectionId
          ? {
              property: s.ga4Property,
              name: s.ga4Name,
              connectionId: s.ga4ConnectionId,
              connectionEmail: email.get(s.ga4ConnectionId) ?? '',
            }
          : null,
      gsc:
        s.gscSite && s.gscConnectionId
          ? { site: s.gscSite, connectionId: s.gscConnectionId, connectionEmail: email.get(s.gscConnectionId) ?? '' }
          : null,
      sitemaps: s.gscSitemaps.map((m) => ({
        path: m.path,
        lastDownloaded: m.lastDownloaded,
        isPending: m.isPending,
        errors: m.errors,
        warnings: m.warnings,
        submitted: m.submitted,
        indexed: m.indexed,
      })),
      syncedAt: s.syncedAt?.toISOString() ?? null,
      syncError: s.syncError,
      lastCheck: checks.get(s.id) ?? null,
      createdByName: by,
      createdAt: s.createdAt.toISOString(),
    }));
  }

  private async checksOut(tx: Tx, rows: CheckRow[]): Promise<WebCheckResponse[]> {
    if (!rows.length) return [];
    const names = await tx
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, [...new Set(rows.map((r) => r.requestedBy))]));
    const name = new Map(names.map((n) => [n.id, n.name]));
    const now = Date.now();
    return rows.map((r) => {
      const stale = r.status === 'running' && now - r.startedAt.getTime() > STALE_CHECK_MS;
      return {
        id: r.id,
        siteId: r.siteId,
        status: stale ? 'failed' : r.status,
        pages: r.pages,
        links: r.links,
        errors: r.errors,
        warnings: r.warnings,
        avgMs: r.avgMs,
        maxMs: r.maxMs,
        error: stale ? 'Bị ngắt giữa chừng' : r.error,
        requestedByName: name.get(r.requestedBy) ?? '',
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      };
    });
  }

  private log(tx: Tx, ctx: Ctx, action: string, targetId: string, metadata: Record<string, unknown>) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'web_site',
      targetId,
      metadata,
      ip: ctx.ip,
    });
  }
}
