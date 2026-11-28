import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@maris/db';
import { WEB_LIMITS, type WebSyncResponse, type WebTopKind } from '@maris/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { GoogleApiService, type GoogleCtx } from '../google/google-api.service';
import { clip, ga4Day, int, lastDays, num } from './rules';

const { webSites, webGa4Daily, webGscDaily, webTops } = schema;

export type SiteRow = typeof webSites.$inferSelect;

const TICK_MS = 5 * 60_000;
/** Daily numbers read each time, so a report can compare 90 days with the 90 before. */
export const SYNC_DAYS = 180;

interface Ga4Report {
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
  metadata?: { currencyCode?: string; timeZone?: string };
}

interface GscRows {
  rows?: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[];
}

interface GscSitemaps {
  sitemap?: {
    path?: string;
    lastSubmitted?: string;
    lastDownloaded?: string;
    isPending?: boolean;
    errors?: string | number;
    warnings?: string | number;
    contents?: { type?: string; submitted?: string | number; indexed?: string | number }[];
  }[];
}

interface TopIn {
  key: string;
  a: number;
  b: number;
  c: number;
  d: number;
}

const errMessage = (e: unknown) =>
  e instanceof HttpException
    ? String((e.getResponse() as { message?: string }).message ?? e.message)
    : e instanceof Error
      ? e.message
      : String(e);

/**
 * Reads Google Analytics 4 and Search Console numbers of each linked website (spec Part 16) into
 * the web schema: daily numbers for the last SYNC_DAYS days, the top pages, channels, queries and
 * pages of the last 28 days, and the sitemaps. MARIS only reads; every call goes through the
 * Google gateway with the account's read-only scopes.
 */
@Injectable()
export class WebSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WebSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly running = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly google: GoogleApiService,
  ) {}

  onModuleInit(): void {
    if (!this.config.WEB_SYNC_HOURS) return;
    this.timer = setInterval(() => void this.pollOnce().catch((e) => this.log.error(e)), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Every enabled, linked site whose last read is older than WEB_SYNC_HOURS. */
  async pollOnce(): Promise<number> {
    if (this.polling || !this.config.WEB_SYNC_HOURS) return 0;
    this.polling = true;
    try {
      const sites = await this.db.withSystem('web_sync', (tx) =>
        tx
          .select()
          .from(webSites)
          .where(
            and(
              isNull(webSites.removedAt),
              eq(webSites.enabled, true),
              sql`(${webSites.ga4Property} IS NOT NULL OR ${webSites.gscSite} IS NOT NULL)`,
              sql`(${webSites.syncedAt} IS NULL OR ${webSites.syncedAt} < now() - make_interval(hours => ${this.config.WEB_SYNC_HOURS}))`,
            ),
          ),
      );
      let n = 0;
      for (const s of sites) {
        try {
          await this.syncSite({ tenantId: s.tenantId, userId: null }, s);
          n++;
        } catch (e) {
          this.log.warn(`site ${s.id}: ${errMessage(e)}`);
        }
      }
      return n;
    } finally {
      this.polling = false;
    }
  }

  /** Reads one site. A failure of one source is kept on the site and does not stop the other. */
  async syncSite(ctx: GoogleCtx, site: SiteRow): Promise<WebSyncResponse> {
    if (this.running.has(site.id))
      throw new HttpException(
        { code: 'WEB_SYNC_RUNNING', message: `MARIS đang đọc số liệu của ${site.name}` },
        409,
      );
    this.running.add(site.id);
    const out: WebSyncResponse = { sites: 1, days: 0, errors: [] };
    try {
      const now = new Date();
      if (site.ga4Property && site.ga4ConnectionId)
        await this.syncGa4(ctx, site, now, out).catch((e: unknown) =>
          out.errors.push(`GA4: ${errMessage(e)}`),
        );
      if (site.gscSite && site.gscConnectionId)
        await this.syncGsc(ctx, site, now, out).catch((e: unknown) =>
          out.errors.push(`Search Console: ${errMessage(e)}`),
        );
      await this.db.withContext(ctx, (tx) =>
        tx
          .update(webSites)
          .set({ syncedAt: new Date(), syncError: out.errors.length ? clip(out.errors.join('; '), 500) : null })
          .where(eq(webSites.id, site.id)),
      );
      return out;
    } finally {
      this.running.delete(site.id);
    }
  }

  // ------------------------------------------------------------------------------------ GA4

  private ga4(ctx: GoogleCtx, site: SiteRow, json: unknown) {
    return this.google.call<Ga4Report>(ctx, {
      service: 'analytics',
      priority: 'background',
      method: 'POST',
      host: 'analytics_data',
      path: `/v1beta/${site.ga4Property}:runReport`,
      json,
      auth: { kind: 'connection', connectionId: site.ga4ConnectionId! },
    });
  }

  private async syncGa4(ctx: GoogleCtx, site: SiteRow, now: Date, out: WebSyncResponse) {
    const range = lastDays(now, SYNC_DAYS);
    const top = lastDays(now, WEB_LIMITS.days);
    const daily = await this.ga4(ctx, site, {
      dateRanges: [{ startDate: range.from, endDate: range.to }],
      dimensions: [{ name: 'date' }],
      metrics: ['sessions', 'totalUsers', 'newUsers', 'screenPageViews', 'keyEvents', 'engagementRate'].map(
        (name) => ({ name }),
      ),
      limit: SYNC_DAYS + 5,
    });
    const pages = await this.ga4(ctx, site, {
      dateRanges: [{ startDate: top.from, endDate: top.to }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: WEB_LIMITS.tops,
    });
    const channels = await this.ga4(ctx, site, {
      dateRanges: [{ startDate: top.from, endDate: top.to }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: WEB_LIMITS.tops,
    });
    const days = (daily.body.rows ?? [])
      .map((r) => {
        const m = (i: number) => r.metricValues?.[i]?.value;
        return {
          day: ga4Day(r.dimensionValues?.[0]?.value),
          sessions: int(m(0)),
          users: int(m(1)),
          newUsers: int(m(2)),
          views: int(m(3)),
          keyEvents: Math.min(num(m(4)), 1e11).toFixed(2),
          engagementRate: Math.min(num(m(5)), 1).toFixed(4),
        };
      })
      .filter((d): d is typeof d & { day: string } => d.day !== null);
    const tops = (r: Ga4Report): TopIn[] =>
      (r.rows ?? [])
        .map((row) => ({
          key: clip(row.dimensionValues?.[0]?.value || '(không rõ)', 500),
          a: num(row.metricValues?.[0]?.value),
          b: num(row.metricValues?.[1]?.value),
          c: 0,
          d: 0,
        }));
    const currency = daily.body.metadata?.currencyCode;
    await this.db.withContext(ctx, async (tx) => {
      for (const d of days)
        await tx
          .insert(webGa4Daily)
          .values({ siteId: site.id, tenantId: ctx.tenantId, ...d })
          .onConflictDoUpdate({
            target: [webGa4Daily.siteId, webGa4Daily.day],
            set: {
              sessions: d.sessions,
              users: d.users,
              newUsers: d.newUsers,
              views: d.views,
              keyEvents: d.keyEvents,
              engagementRate: d.engagementRate,
            },
          });
      await this.replaceTops(tx, ctx, site.id, 'ga4_page', tops(pages.body));
      await this.replaceTops(tx, ctx, site.id, 'ga4_channel', tops(channels.body));
      if (currency && /^[A-Z]{3}$/.test(currency))
        await tx.update(webSites).set({ currency }).where(eq(webSites.id, site.id));
    });
    out.days += days.length;
  }

  // -------------------------------------------------------------------------- Search Console

  private gsc<T>(ctx: GoogleCtx, site: SiteRow, method: 'GET' | 'POST', tail: string, json?: unknown) {
    return this.google.call<T>(ctx, {
      service: 'search_console',
      priority: 'background',
      method,
      host: 'search_console',
      path: `/webmasters/v3/sites/${encodeURIComponent(site.gscSite!)}${tail}`,
      json,
      auth: { kind: 'connection', connectionId: site.gscConnectionId! },
    });
  }

  private async syncGsc(ctx: GoogleCtx, site: SiteRow, now: Date, out: WebSyncResponse) {
    const range = lastDays(now, SYNC_DAYS);
    const top = lastDays(now, WEB_LIMITS.days);
    const query = (dimension: string, r: { from: string; to: string }, rowLimit: number) =>
      this.gsc<GscRows>(ctx, site, 'POST', '/searchAnalytics/query', {
        startDate: r.from,
        endDate: r.to,
        dimensions: [dimension],
        type: 'web',
        rowLimit,
      });
    const daily = await query('date', range, SYNC_DAYS + 5);
    const queries = await query('query', top, WEB_LIMITS.tops);
    const pages = await query('page', top, WEB_LIMITS.tops);
    const sitemaps = await this.gsc<GscSitemaps>(ctx, site, 'GET', '/sitemaps');

    const days = (daily.body.rows ?? [])
      .map((r) => ({
        day: /^\d{4}-\d{2}-\d{2}$/.test(r.keys?.[0] ?? '') ? r.keys![0]! : null,
        clicks: int(r.clicks),
        impressions: int(r.impressions),
        ctr: Math.min(num(r.ctr), 1).toFixed(6),
        position: Math.min(num(r.position), 999_999).toFixed(2),
      }))
      .filter((d): d is typeof d & { day: string } => d.day !== null);
    const tops = (r: GscRows): TopIn[] =>
      (r.rows ?? [])
        .filter((row) => row.keys?.[0])
        .map((row) => ({
          key: clip(row.keys![0]!, 500),
          a: num(row.clicks),
          b: num(row.impressions),
          c: Math.min(num(row.ctr), 1),
          d: num(row.position),
        }));
    const n = (v: string | number | undefined) => (v === undefined ? 0 : int(v));
    const maps: schema.WebSitemap[] = (sitemaps.body.sitemap ?? [])
      .filter((s) => s.path)
      .slice(0, 50)
      .map((s) => {
        const web = s.contents?.find((c) => c.type === 'web') ?? s.contents?.[0];
        return {
          path: clip(s.path!, 500),
          lastSubmitted: s.lastSubmitted ?? null,
          lastDownloaded: s.lastDownloaded ?? null,
          isPending: Boolean(s.isPending),
          errors: n(s.errors),
          warnings: n(s.warnings),
          submitted: web?.submitted === undefined ? null : int(web.submitted),
          indexed: web?.indexed === undefined ? null : int(web.indexed),
        };
      });
    await this.db.withContext(ctx, async (tx) => {
      for (const d of days)
        await tx
          .insert(webGscDaily)
          .values({ siteId: site.id, tenantId: ctx.tenantId, ...d })
          .onConflictDoUpdate({
            target: [webGscDaily.siteId, webGscDaily.day],
            set: { clicks: d.clicks, impressions: d.impressions, ctr: d.ctr, position: d.position },
          });
      await this.replaceTops(tx, ctx, site.id, 'gsc_query', tops(queries.body));
      await this.replaceTops(tx, ctx, site.id, 'gsc_page', tops(pages.body));
      await tx.update(webSites).set({ gscSitemaps: maps }).where(eq(webSites.id, site.id));
    });
    out.days += days.length;
  }

  private async replaceTops(tx: Tx, ctx: GoogleCtx, siteId: string, kind: WebTopKind, rows: TopIn[]) {
    await tx.delete(webTops).where(and(eq(webTops.siteId, siteId), eq(webTops.kind, kind)));
    const seen = new Set<string>();
    const values = rows
      .filter((r) => !seen.has(r.key) && seen.add(r.key))
      .slice(0, WEB_LIMITS.tops)
      .map((r, i) => ({
        siteId,
        tenantId: ctx.tenantId,
        kind,
        key: r.key,
        rank: i + 1,
        a: Math.min(r.a, 1e11).toFixed(4),
        b: Math.min(r.b, 1e11).toFixed(4),
        c: Math.min(r.c, 1e11).toFixed(4),
        d: Math.min(r.d, 1e11).toFixed(4),
      }));
    if (values.length) await tx.insert(webTops).values(values);
  }
}
