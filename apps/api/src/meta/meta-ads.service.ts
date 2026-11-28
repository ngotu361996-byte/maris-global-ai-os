import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  AD_ACCOUNT_STATUS_LABEL,
  AD_STATUS_LABEL,
  META_FEATURES,
  type AdAccountResponse,
  type AdAlert,
  type AdChangeResponse,
  type AdObjectResponse,
  type AdsSummaryResponse,
  type AdSyncResponse,
  type CampaignDetail,
  type DecideAdChange,
  type ListAds,
  type SetAdAccount,
  type SetAdBudget,
  type SetAdStatus,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import {
  add,
  alertsFor,
  daysBetween,
  dayIn,
  metricsOf,
  needsApproval,
  parseInsight,
  seriesOf,
  toMajor,
  toMinor,
  ZERO,
  type DayFigures,
  type GraphInsight,
} from './ads-analysis';
import { MetaError, MetaGraphService, type GraphCtx } from './meta-graph.service';

const { metaAssets, metaConnections, metaAdObjects, metaAdInsights, metaAdChanges, users } = schema;
type AssetRow = typeof metaAssets.$inferSelect;
type ObjectRow = typeof metaAdObjects.$inferSelect;
type ChangeRow = typeof metaAdChanges.$inferSelect;

const TICK_MS = 60_000;
/** Ad accounts read per tenant per tick: one, in turn (spec Part 15 "10 accounts in rotation"). */
const ACCOUNTS_PER_TICK = 1;
/** Campaigns, ad sets and ads change less often than figures: read them every 3 hours. */
const STRUCTURE_EVERY_MS = 3 * 3600_000;
/** The first read takes 30 days of figures; later reads re-read the last 3 (Meta revises them). */
const FIRST_DAYS = 30;
const REREAD_DAYS = 3;
const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const READ_SCOPES = ['ads_read', 'ads_management'];
const MANAGE_SCOPES = META_FEATURES.find((f) => f.key === 'ads_manage')!
  .scopes as readonly string[];

const digits = (v: unknown): string | null =>
  typeof v === 'string' && /^[0-9]{1,30}$/.test(v) ? v : null;
const statusOf = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^[A-Z_]{1,40}$/.test(v) ? v : fallback;
const budgetOf = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface GraphObject {
  id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  campaign_id?: string;
  adset_id?: string;
}
type Paged<T> = { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } };

/**
 * Meta Ads Command Center (spec Part 19, M23) and spend analysis (Part 14). Reads campaigns,
 * ad sets, ads and daily campaign figures of each enabled ad account through the API Governor
 * (group ads_insights, in the background one account per minute in turn), works out CTR, CPC,
 * CPM, CPA and the ROAS Meta reports, and points out unusual figures. Pausing, turning on and
 * daily budgets are sent through group ads_manage; a change that would take a budget above the
 * account's approved limit waits for a person with ads.approve.
 */
@Injectable()
export class MetaAdsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MetaAdsService.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly graph: MetaGraphService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!this.config.META_ADS_POLL_MIN) return;
    this.timer = setInterval(() => void this.pollOnce().catch((e) => this.log.error(e)), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------------------------------------------------------------------------------- reading Meta

  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const tenants = await this.db.withSystem('meta_ads', (tx) =>
        tx
          .select({ tenantId: metaConnections.tenantId, userId: metaConnections.connectedBy })
          .from(metaConnections)
          .where(eq(metaConnections.status, 'active')),
      );
      let n = 0;
      for (const t of tenants) {
        try {
          n += (await this.syncTenant({ tenantId: t.tenantId, userId: t.userId }, false)).accounts;
        } catch (e) {
          this.log.warn(`ads poll ${t.tenantId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return n;
    } finally {
      this.polling = false;
    }
  }

  /** Reads every enabled ad account when a person asks, else the one due next. */
  async syncTenant(ctx: GraphCtx, manual: boolean): Promise<AdSyncResponse> {
    const out: AdSyncResponse = { accounts: 0, campaigns: 0, days: 0, errors: [] };
    const accounts = await this.db.withContext(ctx, async (tx) => {
      const scopes = await this.scopes(tx, ctx.tenantId);
      if (!READ_SCOPES.some((s) => scopes.includes(s))) {
        if (manual)
          throw new MetaError(
            409,
            'META_PERMISSION_MISSING',
            'Chưa cấp quyền ads_read cho MARIS. Kết nối lại Facebook trong Trung tâm Meta',
          );
        return [];
      }
      const due = new Date(Date.now() - this.config.META_ADS_POLL_MIN * 60_000);
      return tx
        .select()
        .from(metaAssets)
        .where(
          and(
            eq(metaAssets.tenantId, ctx.tenantId),
            eq(metaAssets.kind, 'ad_account'),
            eq(metaAssets.enabled, true),
            isNull(metaAssets.removedAt),
            manual
              ? undefined
              : or(isNull(metaAssets.adsSyncedAt), lt(metaAssets.adsSyncedAt, due)),
          ),
        )
        .orderBy(sql`${metaAssets.adsSyncedAt} ASC NULLS FIRST`, asc(metaAssets.id))
        .limit(manual ? 20 : ACCOUNTS_PER_TICK);
    });
    for (const account of accounts) {
      let error: string | null = null;
      try {
        const r = await this.syncAccount(ctx, account, manual);
        out.accounts++;
        out.campaigns += r.campaigns;
        out.days += r.days;
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        out.errors.push(`${account.name}: ${error}`);
        // Refused by the Governor: try again at the next turn, do not mark the account read.
        if (e instanceof MetaError && e.code === 'META_BUDGET' && !manual) continue;
      }
      await this.db.withContext(ctx, (tx) =>
        tx
          .update(metaAssets)
          .set({ adsSyncedAt: new Date(), adsError: error })
          .where(eq(metaAssets.id, account.id)),
      );
    }
    return out;
  }

  private async syncAccount(
    ctx: GraphCtx,
    account: AssetRow,
    manual: boolean,
  ): Promise<{ campaigns: number; days: number }> {
    let campaigns = 0;
    const structureDue =
      manual ||
      !account.adsStructureAt ||
      Date.now() - account.adsStructureAt.getTime() > STRUCTURE_EVERY_MS;
    if (structureDue) campaigns = await this.syncStructure(ctx, account, manual);

    const now = new Date();
    const until = dayIn(account.timezone, now);
    const since = dayIn(
      account.timezone,
      now,
      account.adsSyncedAt ? REREAD_DAYS - 1 : FIRST_DAYS - 1,
    );
    let rows = await this.readInsights(ctx, account, since, until, manual);
    let known = await this.campaignIds(ctx, account.id);
    if (!structureDue && rows.some((r) => !known.has(r.campaign_id ?? ''))) {
      // A campaign made since the last read: read the structure now.
      campaigns = await this.syncStructure(ctx, account, manual);
      known = await this.campaignIds(ctx, account.id);
    }
    rows = rows.filter(
      (r) => known.has(r.campaign_id ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(r.date_start ?? ''),
    );
    await this.db.withContext(ctx, async (tx) => {
      for (const r of rows) {
        const f = parseInsight(r);
        const values = {
          spend: String(f.spend),
          impressions: f.impressions,
          reach: f.reach,
          clicks: f.clicks,
          linkClicks: f.linkClicks,
          purchases: f.purchases,
          purchaseValue: String(f.purchaseValue),
          leads: f.leads,
          messages: f.messages,
          syncedAt: new Date(),
        };
        await tx
          .insert(metaAdInsights)
          .values({
            tenantId: ctx.tenantId,
            assetId: account.id,
            objectId: known.get(r.campaign_id!)!,
            day: r.date_start!,
            ...values,
          })
          .onConflictDoUpdate({
            target: [metaAdInsights.objectId, metaAdInsights.day],
            set: values,
          });
      }
    });
    return { campaigns, days: rows.length };
  }

  private async campaignIds(ctx: GraphCtx, assetId: string): Promise<Map<string, string>> {
    const rows = await this.db.withContext(ctx, (tx) =>
      tx
        .select({ id: metaAdObjects.id, ext: metaAdObjects.externalId })
        .from(metaAdObjects)
        .where(and(eq(metaAdObjects.assetId, assetId), eq(metaAdObjects.level, 'campaign'))),
    );
    return new Map(rows.map((r) => [r.ext, r.id]));
  }

  private read<T>(
    ctx: GraphCtx,
    account: AssetRow,
    manual: boolean,
    path: string,
    params: Record<string, string | number>,
  ) {
    return this.graph.call<Paged<T>>(ctx, {
      group: 'ads_insights',
      priority: manual ? 'normal' : 'background',
      method: 'GET',
      path,
      params,
      auth: { kind: 'user' },
      assetId: account.id,
    });
  }

  private async readAll<T>(
    ctx: GraphCtx,
    account: AssetRow,
    manual: boolean,
    path: string,
    params: Record<string, string | number>,
  ): Promise<T[]> {
    const out: T[] = [];
    const p = { ...params };
    for (let i = 0; i < MAX_PAGES; i++) {
      const r = await this.read<T>(ctx, account, manual, path, p);
      out.push(...(r.data ?? []));
      const after = r.paging?.next ? r.paging.cursors?.after : undefined;
      if (!after || !(r.data ?? []).length) break;
      p.after = after;
    }
    return out;
  }

  private readInsights(
    ctx: GraphCtx,
    account: AssetRow,
    since: string,
    until: string,
    manual: boolean,
  ) {
    return this.readAll<GraphInsight>(ctx, account, manual, `/${account.externalId}/insights`, {
      level: 'campaign',
      time_increment: 1,
      time_range: JSON.stringify({ since, until }),
      fields:
        'campaign_id,date_start,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values',
      limit: 500,
    });
  }

  /** Campaigns, ad sets and ads of one account; those Meta no longer lists are marked absent. */
  private async syncStructure(ctx: GraphCtx, account: AssetRow, manual: boolean): Promise<number> {
    const base = 'id,name,status,effective_status';
    const camps = await this.readAll<GraphObject>(
      ctx,
      account,
      manual,
      `/${account.externalId}/campaigns`,
      {
        fields: `${base},objective,daily_budget,lifetime_budget`,
        limit: PAGE_LIMIT,
      },
    );
    const adsets = await this.readAll<GraphObject>(
      ctx,
      account,
      manual,
      `/${account.externalId}/adsets`,
      {
        fields: `${base},campaign_id,daily_budget,lifetime_budget`,
        limit: PAGE_LIMIT,
      },
    );
    const ads = await this.readAll<GraphObject>(
      ctx,
      account,
      manual,
      `/${account.externalId}/ads`,
      {
        fields: `${base},campaign_id,adset_id`,
        limit: PAGE_LIMIT,
      },
    );

    await this.db.withContext(ctx, async (tx) => {
      const now = new Date();
      const existing = await tx
        .select({ id: metaAdObjects.id, ext: metaAdObjects.externalId })
        .from(metaAdObjects)
        .where(eq(metaAdObjects.tenantId, ctx.tenantId));
      const ids = new Map(existing.map((r) => [r.ext, r.id]));
      const seen: string[] = [];
      const upsert = async (
        level: ObjectRow['level'],
        o: GraphObject,
        parents: { campaignId: string | null; adsetId: string | null },
      ) => {
        const ext = digits(o.id);
        if (!ext) return;
        const id = ids.get(ext) ?? uuidv7();
        ids.set(ext, id);
        seen.push(id);
        const status = statusOf(o.status, 'PAUSED');
        const values = {
          assetId: account.id,
          level,
          ...parents,
          name: (typeof o.name === 'string' && o.name.trim() ? o.name.trim() : ext).slice(0, 400),
          status,
          effectiveStatus: statusOf(o.effective_status, status),
          objective: typeof o.objective === 'string' ? o.objective.slice(0, 60) : null,
          dailyBudget: budgetOf(o.daily_budget),
          lifetimeBudget: budgetOf(o.lifetime_budget),
          present: true,
          syncedAt: now,
        };
        await tx
          .insert(metaAdObjects)
          .values({ id, tenantId: ctx.tenantId, externalId: ext, ...values })
          .onConflictDoUpdate({
            target: [metaAdObjects.tenantId, metaAdObjects.externalId],
            set: values,
          });
      };
      const idOf = (ext: unknown) => {
        const d = digits(ext);
        return d ? (ids.get(d) ?? null) : null;
      };
      for (const c of camps) await upsert('campaign', c, { campaignId: null, adsetId: null });
      for (const s of adsets)
        await upsert('adset', s, { campaignId: idOf(s.campaign_id), adsetId: null });
      for (const a of ads)
        await upsert('ad', a, { campaignId: idOf(a.campaign_id), adsetId: idOf(a.adset_id) });
      await tx
        .update(metaAdObjects)
        .set({ present: false })
        .where(
          and(
            eq(metaAdObjects.assetId, account.id),
            seen.length ? notInArray(metaAdObjects.id, seen) : undefined,
          ),
        );
      await tx.update(metaAssets).set({ adsStructureAt: now }).where(eq(metaAssets.id, account.id));
    });
    return camps.length;
  }

  // ---------------------------------------------------------------------------------- analysis

  async summary(
    ctx: Ctx,
    f: ListAds,
    canManage: boolean,
    canApprove = false,
  ): Promise<AdsSummaryResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const scopes = await this.scopes(tx, ctx.tenantId);
      const missing = READ_SCOPES.some((s) => scopes.includes(s)) ? [] : ['ads_read'];
      const accounts = await this.accounts(tx, ctx.tenantId, f.accountId);
      const out: AdAccountResponse[] = [];
      const totals = new Map<string, DayFigures>();
      const seriesDays = new Map<string, DayFigures>();
      const alerts: AdAlert[] = [];
      let allDays: string[] = [];
      for (const a of accounts) {
        const until = dayIn(a.timezone, new Date());
        const since = dayIn(a.timezone, new Date(), f.days - 1);
        const from = dayIn(a.timezone, new Date(), Math.max(f.days, 14) - 1);
        const days = daysBetween(since, until);
        if (days.length > allDays.length) allDays = days;
        const camps = await tx
          .select()
          .from(metaAdObjects)
          .where(and(eq(metaAdObjects.assetId, a.id), eq(metaAdObjects.level, 'campaign')));
        const rows = await tx
          .select()
          .from(metaAdInsights)
          .where(
            and(
              eq(metaAdInsights.assetId, a.id),
              gte(metaAdInsights.day, from),
              lte(metaAdInsights.day, until),
            ),
          );
        let sum = ZERO;
        const byCampaign = new Map<string, Map<string, DayFigures>>();
        for (const r of rows) {
          const fig = figuresOf(r);
          const m = byCampaign.get(r.objectId) ?? new Map<string, DayFigures>();
          m.set(r.day, fig);
          byCampaign.set(r.objectId, m);
          if (r.day >= since) {
            sum = add(sum, fig);
            seriesDays.set(r.day, add(seriesDays.get(r.day) ?? ZERO, fig));
          }
        }
        const cur = a.currency ?? '—';
        totals.set(cur, add(totals.get(cur) ?? ZERO, sum));
        const disapproved = await tx
          .select({ name: metaAdObjects.name, campaignId: metaAdObjects.campaignId })
          .from(metaAdObjects)
          .where(
            and(
              eq(metaAdObjects.assetId, a.id),
              eq(metaAdObjects.level, 'ad'),
              eq(metaAdObjects.present, true),
              eq(metaAdObjects.effectiveStatus, 'DISAPPROVED'),
            ),
          );
        const campName = new Map(camps.map((c) => [c.id, c.name]));
        const campStatus = new Map(camps.map((c) => [c.id, c.status]));
        const alertDays = daysBetween(from, until);
        alerts.push(
          ...alertsFor({
            id: a.id,
            name: a.name,
            accountStatus: a.accountStatus,
            currency: a.currency,
            today: until,
            campaigns: camps
              .filter(
                (c) =>
                  c.present && c.effectiveStatus !== 'DELETED' && c.effectiveStatus !== 'ARCHIVED',
              )
              .filter((c) => c.effectiveStatus === 'ACTIVE' || byCampaign.has(c.id))
              .map((c) => ({
                id: c.id,
                name: c.name,
                effectiveStatus: c.effectiveStatus,
                days: alertDays.map((day) => ({ day, f: byCampaign.get(c.id)?.get(day) ?? ZERO })),
              })),
            // Only campaigns that are on, in an account that can run: the rest do not spend.
            disapproved: disapproved
              .filter((d) => a.accountStatus === null || a.accountStatus === 1)
              .filter((d) => !!d.campaignId && campStatus.get(d.campaignId) === 'ACTIVE')
              .map((d) => ({
                adName: d.name,
                campaignId: d.campaignId,
                campaignName: d.campaignId ? (campName.get(d.campaignId) ?? null) : null,
              })),
          }),
        );
        const live = camps.filter((c) => c.present);
        out.push({
          id: a.id,
          externalId: a.externalId,
          name: a.name,
          currency: a.currency,
          timezone: a.timezone,
          accountStatus: a.accountStatus,
          accountStatusLabel:
            a.accountStatus === null
              ? null
              : (AD_ACCOUNT_STATUS_LABEL[a.accountStatus] ?? `Mã ${a.accountStatus}`),
          dailyCap: toMajor(a.adsDailyCap, a.currency),
          syncedAt: iso(a.adsSyncedAt),
          error: a.adsError,
          campaigns: live.length,
          activeCampaigns: live.filter((c) => c.effectiveStatus === 'ACTIVE').length,
          metrics: metricsOf(sum),
        });
      }
      const [pending] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(metaAdChanges)
        .where(and(eq(metaAdChanges.tenantId, ctx.tenantId), eq(metaAdChanges.status, 'pending')));
      return {
        ready: missing.length === 0 && accounts.length > 0,
        canManage: canManage && MANAGE_SCOPES.every((s) => scopes.includes(s)),
        canApprove,
        missingScopes: missing,
        pollMinutes: this.config.META_ADS_POLL_MIN,
        days: f.days,
        accounts: out,
        totals: [...totals].map(([currency, t]) => ({ currency, metrics: metricsOf(t) })),
        series: seriesOf(allDays, seriesDays),
        alerts,
        pendingChanges: pending?.n ?? 0,
      };
    });
  }

  async campaigns(ctx: Ctx, f: ListAds): Promise<AdObjectResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const accounts = await this.accounts(tx, ctx.tenantId, f.accountId);
      const out: AdObjectResponse[] = [];
      for (const a of accounts) {
        const until = dayIn(a.timezone, new Date());
        const since = dayIn(a.timezone, new Date(), f.days - 1);
        const camps = await tx
          .select()
          .from(metaAdObjects)
          .where(and(eq(metaAdObjects.assetId, a.id), eq(metaAdObjects.level, 'campaign')));
        const sums = await this.sums(tx, a.id, since, until);
        const open = await this.openChanges(
          tx,
          camps.map((c) => c.id),
        );
        for (const c of camps)
          out.push({
            ...objectOut(c, a, open.get(c.id) ?? null),
            metrics: metricsOf(sums.get(c.id) ?? ZERO),
          });
      }
      // Present first, then most spent.
      return out.sort(
        (x, y) =>
          Number(y.present) - Number(x.present) ||
          (y.metrics?.spend ?? 0) - (x.metrics?.spend ?? 0),
      );
    });
  }

  async campaign(ctx: Ctx, id: string, days: number): Promise<CampaignDetail> {
    return this.db.withContext(ctx, async (tx) => {
      const c = await this.object(tx, ctx.tenantId, id);
      if (c.level !== 'campaign')
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không có chiến dịch này' });
      const a = await this.accountOf(tx, c);
      const until = dayIn(a.timezone, new Date());
      const since = dayIn(a.timezone, new Date(), days - 1);
      const rows = await tx
        .select()
        .from(metaAdInsights)
        .where(
          and(
            eq(metaAdInsights.objectId, c.id),
            gte(metaAdInsights.day, since),
            lte(metaAdInsights.day, until),
          ),
        );
      const byDay = new Map(rows.map((r) => [r.day, figuresOf(r)]));
      const total = rows.reduce((s, r) => add(s, figuresOf(r)), ZERO);
      const children = await tx
        .select()
        .from(metaAdObjects)
        .where(eq(metaAdObjects.campaignId, c.id))
        .orderBy(desc(metaAdObjects.present), asc(metaAdObjects.name));
      const open = await this.openChanges(tx, [c.id, ...children.map((x) => x.id)]);
      const kid = (x: ObjectRow) => objectOut(x, a, open.get(x.id) ?? null);
      return {
        ...objectOut(c, a, open.get(c.id) ?? null),
        metrics: metricsOf(total),
        series: seriesOf(daysBetween(since, until), byDay),
        adsets: children.filter((x) => x.level === 'adset').map(kid),
        ads: children.filter((x) => x.level === 'ad').map(kid),
      };
    });
  }

  // ---------------------------------------------------------------------------------- changes

  async setStatus(ctx: Ctx, id: string, body: SetAdStatus): Promise<AdChangeResponse> {
    const change = await this.db.withContext(ctx, async (tx) => {
      const o = await this.object(tx, ctx.tenantId, id);
      await this.checkManage(tx, ctx.tenantId);
      if (!o.present || !['ACTIVE', 'PAUSED'].includes(o.status))
        throw new ConflictException({
          code: 'ADS_NOT_EDITABLE',
          message: 'Mục này đã xóa hoặc lưu trữ trên Meta, không đổi trạng thái được',
        });
      if (o.status === body.status)
        throw new ConflictException({
          code: 'ADS_NO_CHANGE',
          message: body.status === 'ACTIVE' ? 'Mục này đang bật' : 'Mục này đang tạm dừng',
        });
      if (body.status === 'ACTIVE' && o.effectiveStatus === 'DISAPPROVED')
        throw new ConflictException({
          code: 'ADS_DISAPPROVED',
          message:
            'Quảng cáo bị Meta từ chối. Sửa theo chính sách rồi gửi lại trong Trình quản lý quảng cáo; MARIS không bật lại để né kiểm duyệt',
        });
      const a = await this.accountOf(tx, o);
      const approval = needsApproval({ kind: 'status', to: body.status }, o, a.adsDailyCap);
      return this.newChange(tx, ctx, o, 'status', o.status, body.status, body.reason, approval);
    });
    return change.needsApproval ? this.changeOut(ctx, change.id) : this.apply(ctx, change.id);
  }

  async setBudget(ctx: Ctx, id: string, body: SetAdBudget): Promise<AdChangeResponse> {
    const change = await this.db.withContext(ctx, async (tx) => {
      const o = await this.object(tx, ctx.tenantId, id);
      await this.checkManage(tx, ctx.tenantId);
      if (o.level === 'ad' || o.dailyBudget === null)
        throw new ConflictException({
          code: 'ADS_NO_DAILY_BUDGET',
          message:
            o.level === 'ad'
              ? 'Ngân sách đặt ở chiến dịch hoặc nhóm quảng cáo, không ở từng quảng cáo'
              : 'Mục này không dùng ngân sách hằng ngày (ngân sách nằm ở cấp khác hoặc là ngân sách trọn đời)',
        });
      if (!o.present || ['DELETED', 'ARCHIVED'].includes(o.status))
        throw new ConflictException({
          code: 'ADS_NOT_EDITABLE',
          message: 'Mục này đã xóa hoặc lưu trữ trên Meta',
        });
      const a = await this.accountOf(tx, o);
      const to = toMinor(body.dailyBudget, a.currency);
      if (to === o.dailyBudget)
        throw new ConflictException({ code: 'ADS_NO_CHANGE', message: 'Ngân sách không đổi' });
      const approval = needsApproval({ kind: 'daily_budget', to }, o, a.adsDailyCap);
      return this.newChange(
        tx,
        ctx,
        o,
        'daily_budget',
        String(o.dailyBudget),
        String(to),
        body.reason,
        approval,
      );
    });
    return change.needsApproval ? this.changeOut(ctx, change.id) : this.apply(ctx, change.id);
  }

  async approve(ctx: Ctx, id: string, body: DecideAdChange): Promise<AdChangeResponse> {
    await this.db.withContext(ctx, async (tx) => {
      const c = await this.change(tx, ctx.tenantId, id);
      if (c.status !== 'pending')
        throw new ConflictException({
          code: 'ADS_CHANGE_CLOSED',
          message: 'Thay đổi này đã được xử lý',
        });
      await this.checkManage(tx, ctx.tenantId);
      await tx
        .update(metaAdChanges)
        .set({ decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: body.note || null })
        .where(eq(metaAdChanges.id, id));
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ads.change.approved',
        targetType: 'meta_ad_change',
        targetId: id,
        metadata: { kind: c.kind, to: c.toValue },
        ip: ctx.ip,
      });
    });
    return this.apply(ctx, id);
  }

  async reject(
    ctx: Ctx,
    id: string,
    body: DecideAdChange,
    canApprove: boolean,
  ): Promise<AdChangeResponse> {
    await this.db.withContext(ctx, async (tx) => {
      const c = await this.change(tx, ctx.tenantId, id);
      // The person who asked can withdraw it; others need ads.approve.
      const own = c.requestedBy === ctx.userId;
      if (!own && !canApprove)
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Cần quyền ads.approve' });
      const [done] = await tx
        .update(metaAdChanges)
        .set({
          status: own && !canApprove ? 'cancelled' : 'rejected',
          decidedBy: ctx.userId,
          decidedAt: new Date(),
          decisionNote: body.note || null,
        })
        .where(and(eq(metaAdChanges.id, id), eq(metaAdChanges.status, 'pending')))
        .returning();
      if (!done)
        throw new ConflictException({
          code: 'ADS_CHANGE_CLOSED',
          message: 'Thay đổi này đã được xử lý',
        });
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: `ads.change.${done.status}`,
        targetType: 'meta_ad_change',
        targetId: id,
        metadata: { kind: c.kind, to: c.toValue },
        ip: ctx.ip,
      });
    });
    return this.changeOut(ctx, id);
  }

  async changes(ctx: Ctx): Promise<AdChangeResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(metaAdChanges)
        .where(eq(metaAdChanges.tenantId, ctx.tenantId))
        .orderBy(sql`(${metaAdChanges.status} = 'pending') DESC`, desc(metaAdChanges.createdAt))
        .limit(100);
      return this.changesOut(tx, rows);
    });
  }

  async setAccount(ctx: Ctx, id: string, body: SetAdAccount): Promise<AdAccountResponse> {
    await this.db.withContext(ctx, async (tx) => {
      const [a] = await this.accounts(tx, ctx.tenantId, id);
      if (!a)
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Không có tài khoản quảng cáo này',
        });
      const cap = body.dailyCap === null ? null : toMinor(body.dailyCap, a.currency);
      await tx.update(metaAssets).set({ adsDailyCap: cap }).where(eq(metaAssets.id, a.id));
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ads.cap.set',
        targetType: 'meta_asset',
        targetId: a.id,
        metadata: { from: a.adsDailyCap, to: cap, currency: a.currency },
        ip: ctx.ip,
      });
    });
    const s = await this.summary(ctx, { accountId: id, days: 7 }, false);
    return s.accounts[0]!;
  }

  /** Sends one change to Meta. Only one caller can take it from pending. */
  private async apply(ctx: Ctx, id: string): Promise<AdChangeResponse> {
    const claimed = await this.db.withContext(ctx, async (tx) => {
      const [c] = await tx
        .update(metaAdChanges)
        .set({ status: 'applying' })
        .where(
          and(
            eq(metaAdChanges.id, id),
            eq(metaAdChanges.tenantId, ctx.tenantId),
            eq(metaAdChanges.status, 'pending'),
          ),
        )
        .returning();
      if (!c) return null;
      const [o] = await tx.select().from(metaAdObjects).where(eq(metaAdObjects.id, c.objectId));
      return { c, o: o! };
    });
    if (!claimed) return this.changeOut(ctx, id);
    const { c, o } = claimed;
    const pausing = c.kind === 'status' && c.toValue === 'PAUSED';
    let error: string | null = null;
    try {
      await this.graph.call(
        { tenantId: ctx.tenantId, userId: ctx.userId },
        {
          group: 'ads_manage',
          // Stopping spend goes through even when the budget is nearly used.
          priority: pausing ? 'essential' : 'normal',
          method: 'POST',
          path: `/${o.externalId}`,
          params: c.kind === 'status' ? { status: c.toValue } : { daily_budget: c.toValue },
          auth: { kind: 'user' },
          assetId: o.assetId,
        },
      );
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    }
    await this.db.withContext(ctx, async (tx) => {
      await tx
        .update(metaAdChanges)
        .set(error ? { status: 'failed', error } : { status: 'applied', appliedAt: new Date() })
        .where(eq(metaAdChanges.id, c.id));
      if (!error)
        await tx
          .update(metaAdObjects)
          .set(
            c.kind === 'status'
              ? // A refusal by Meta stays until Meta reviews the ad again.
                {
                  status: c.toValue,
                  effectiveStatus:
                    o.effectiveStatus === 'DISAPPROVED' ? o.effectiveStatus : c.toValue,
                }
              : { dailyBudget: Number(c.toValue) },
          )
          .where(eq(metaAdObjects.id, o.id));
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: error ? 'ads.change.failed' : 'ads.change.applied',
        targetType: 'meta_ad_object',
        targetId: o.id,
        metadata: {
          changeId: c.id,
          level: o.level,
          externalId: o.externalId,
          kind: c.kind,
          from: c.fromValue,
          to: c.toValue,
          approved: c.needsApproval,
          ...(error ? { error: error.slice(0, 200) } : {}),
        },
        ip: ctx.ip,
      });
    });
    return this.changeOut(ctx, id);
  }

  private async newChange(
    tx: Tx,
    ctx: Ctx,
    o: ObjectRow,
    kind: 'status' | 'daily_budget',
    from: string,
    to: string,
    reason: string,
    approval: boolean,
  ): Promise<ChangeRow> {
    const [open] = await tx
      .select({ id: metaAdChanges.id })
      .from(metaAdChanges)
      .where(
        and(
          eq(metaAdChanges.objectId, o.id),
          eq(metaAdChanges.kind, kind),
          inArray(metaAdChanges.status, ['pending', 'applying']),
        ),
      );
    if (open)
      throw new ConflictException({
        code: 'ADS_CHANGE_OPEN',
        message: 'Đã có một thay đổi cùng loại đang chờ duyệt hoặc đang gửi cho mục này',
      });
    const [row] = await tx
      .insert(metaAdChanges)
      .values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        objectId: o.id,
        kind,
        fromValue: from,
        toValue: to,
        reason,
        needsApproval: approval,
        requestedBy: ctx.userId,
      })
      .returning();
    await this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'ads.change.requested',
      targetType: 'meta_ad_object',
      targetId: o.id,
      metadata: { changeId: row!.id, level: o.level, kind, from, to, needsApproval: approval },
      ip: ctx.ip,
    });
    return row!;
  }

  // ---------------------------------------------------------------------------------- helpers

  private async scopes(tx: Tx, tenantId: string): Promise<string[]> {
    const [conn] = await tx
      .select()
      .from(metaConnections)
      .where(and(eq(metaConnections.tenantId, tenantId), ne(metaConnections.status, 'removed')));
    return conn?.status === 'active' ? conn.scopes : [];
  }

  private async checkManage(tx: Tx, tenantId: string): Promise<void> {
    const scopes = await this.scopes(tx, tenantId);
    const missing = MANAGE_SCOPES.filter((s) => !scopes.includes(s));
    if (missing.length)
      throw new MetaError(
        409,
        'META_PERMISSION_MISSING',
        `Chưa cấp quyền ${missing.join(', ')} cho MARIS. Kết nối lại Facebook trong Trung tâm Meta`,
      );
  }

  private accounts(tx: Tx, tenantId: string, id?: string): Promise<AssetRow[]> {
    return tx
      .select()
      .from(metaAssets)
      .where(
        and(
          eq(metaAssets.tenantId, tenantId),
          eq(metaAssets.kind, 'ad_account'),
          eq(metaAssets.enabled, true),
          isNull(metaAssets.removedAt),
          id ? eq(metaAssets.id, id) : undefined,
        ),
      )
      .orderBy(asc(metaAssets.name));
  }

  private async accountOf(tx: Tx, o: ObjectRow): Promise<AssetRow> {
    const [a] = await this.accounts(tx, o.tenantId, o.assetId);
    if (!a)
      throw new ConflictException({
        code: 'META_ASSET_OFF',
        message: 'Tài khoản quảng cáo chưa được bật trong Trung tâm Meta',
      });
    return a;
  }

  private async object(tx: Tx, tenantId: string, id: string): Promise<ObjectRow> {
    const [o] = await tx
      .select()
      .from(metaAdObjects)
      .where(and(eq(metaAdObjects.id, id), eq(metaAdObjects.tenantId, tenantId)));
    if (!o)
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không có mục quảng cáo này' });
    return o;
  }

  private async change(tx: Tx, tenantId: string, id: string): Promise<ChangeRow> {
    const [c] = await tx
      .select()
      .from(metaAdChanges)
      .where(and(eq(metaAdChanges.id, id), eq(metaAdChanges.tenantId, tenantId)));
    if (!c) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không có thay đổi này' });
    return c;
  }

  private async sums(
    tx: Tx,
    assetId: string,
    since: string,
    until: string,
  ): Promise<Map<string, DayFigures>> {
    const rows = await tx
      .select()
      .from(metaAdInsights)
      .where(
        and(
          eq(metaAdInsights.assetId, assetId),
          gte(metaAdInsights.day, since),
          lte(metaAdInsights.day, until),
        ),
      );
    const out = new Map<string, DayFigures>();
    for (const r of rows) out.set(r.objectId, add(out.get(r.objectId) ?? ZERO, figuresOf(r)));
    return out;
  }

  private async openChanges(
    tx: Tx,
    ids: string[],
  ): Promise<Map<string, AdObjectResponse['openChange']>> {
    if (!ids.length) return new Map();
    const rows = await tx
      .select()
      .from(metaAdChanges)
      .where(
        and(
          inArray(metaAdChanges.objectId, ids),
          inArray(metaAdChanges.status, ['pending', 'applying']),
        ),
      );
    return new Map(
      rows.map((r) => [
        r.objectId,
        { id: r.id, kind: r.kind, toValue: r.toValue, status: r.status },
      ]),
    );
  }

  private async changeOut(ctx: Ctx, id: string): Promise<AdChangeResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const c = await this.change(tx, ctx.tenantId, id);
      return (await this.changesOut(tx, [c]))[0]!;
    });
  }

  private async changesOut(tx: Tx, rows: ChangeRow[]): Promise<AdChangeResponse[]> {
    if (!rows.length) return [];
    const objs = await tx
      .select({ o: metaAdObjects, a: metaAssets })
      .from(metaAdObjects)
      .innerJoin(metaAssets, eq(metaAssets.id, metaAdObjects.assetId))
      .where(inArray(metaAdObjects.id, [...new Set(rows.map((r) => r.objectId))]));
    const byId = new Map(objs.map((x) => [x.o.id, x]));
    const people = [
      ...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((x): x is string => !!x)),
    ];
    const names = new Map(
      people.length
        ? (
            await tx
              .select({ id: users.id, name: users.displayName })
              .from(users)
              .where(inArray(users.id, people))
          ).map((u) => [u.id, u.name])
        : [],
    );
    return rows.map((r) => {
      const x = byId.get(r.objectId)!;
      const money = (v: string | null) =>
        v === null || r.kind !== 'daily_budget' ? v : String(toMajor(Number(v), x.a.currency));
      return {
        id: r.id,
        objectId: r.objectId,
        objectName: x.o.name,
        level: x.o.level,
        accountName: x.a.name,
        currency: x.a.currency,
        kind: r.kind,
        fromValue: money(r.fromValue),
        toValue: money(r.toValue)!,
        reason: r.reason,
        status: r.status,
        needsApproval: r.needsApproval,
        requestedByName: r.requestedBy ? (names.get(r.requestedBy) ?? null) : null,
        decidedByName: r.decidedBy ? (names.get(r.decidedBy) ?? null) : null,
        decisionNote: r.decisionNote,
        error: r.error,
        createdAt: r.createdAt.toISOString(),
        decidedAt: iso(r.decidedAt),
        appliedAt: iso(r.appliedAt),
      };
    });
  }
}

function figuresOf(r: typeof metaAdInsights.$inferSelect): DayFigures {
  return {
    spend: Number(r.spend),
    impressions: r.impressions,
    reach: r.reach,
    clicks: r.clicks,
    linkClicks: r.linkClicks,
    purchases: r.purchases,
    purchaseValue: Number(r.purchaseValue),
    leads: r.leads,
    messages: r.messages,
  };
}

function objectOut(
  o: ObjectRow,
  a: AssetRow,
  open: AdObjectResponse['openChange'],
): AdObjectResponse {
  return {
    id: o.id,
    accountId: a.id,
    level: o.level,
    externalId: o.externalId,
    name: o.name,
    status: o.status,
    effectiveStatus: o.effectiveStatus,
    statusLabel: AD_STATUS_LABEL[o.effectiveStatus] ?? o.effectiveStatus,
    objective: o.objective,
    dailyBudget: toMajor(o.dailyBudget, a.currency),
    lifetimeBudget: toMajor(o.lifetimeBudget, a.currency),
    currency: a.currency,
    present: o.present,
    campaignId: o.campaignId,
    adsetId: o.adsetId,
    metrics: null,
    openChange: open,
  };
}
