import type { AdAlert, AdDay, AdMetrics } from '@maris/contracts';

/**
 * Pure rules of the Ads Command Center (spec Part 19): money units, reading Meta's insight rows,
 * the ratios (CTR, CPC, CPM, CPA, ROAS), alerts for unusual figures, and when a change needs
 * approval. Kept apart from the service so they can be tested on their own.
 */

/**
 * Currencies Meta keeps budgets for in whole units (offset 1); all others are in hundredths
 * (offset 100, e.g. US cents). Insights (spend) always come in major units.
 */
const OFFSET_ONE = new Set([
  'CLP',
  'COP',
  'CRC',
  'HUF',
  'ISK',
  'IDR',
  'JPY',
  'KRW',
  'PYG',
  'TWD',
  'VND',
]);

export const currencyOffset = (currency: string | null): number =>
  currency && OFFSET_ONE.has(currency) ? 1 : 100;
export const toMinor = (major: number, currency: string | null): number =>
  Math.round(major * currencyOffset(currency));
export const toMajor = (minor: number | null, currency: string | null): number | null =>
  minor === null ? null : minor / currencyOffset(currency);

/** One day of one campaign's figures, as stored. */
export interface DayFigures {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  purchases: number;
  purchaseValue: number;
  leads: number;
  messages: number;
}

export const ZERO: DayFigures = {
  spend: 0,
  impressions: 0,
  reach: 0,
  clicks: 0,
  linkClicks: 0,
  purchases: 0,
  purchaseValue: 0,
  leads: 0,
  messages: 0,
};

type ActionList = { action_type?: string; value?: string | number }[] | undefined;

/** An insight row as Meta gives it (GET /act_x/insights?level=campaign&time_increment=1). */
export interface GraphInsight {
  campaign_id?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: ActionList;
  action_values?: ActionList;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Meta reports the same purchase under several action types (omni_purchase includes the
 * pixel's and the app's); take the first one present, never the sum, so nothing counts twice.
 */
const PURCHASE_TYPES = ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const LEAD_TYPES = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const MESSAGE_TYPES = [
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.total_messaging_connection',
];

export function firstOf(list: ActionList, types: string[]): number {
  if (!Array.isArray(list)) return 0;
  for (const t of types) {
    const hit = list.find((a) => a?.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

export function parseInsight(r: GraphInsight): DayFigures {
  return {
    spend: Math.round(num(r.spend) * 100) / 100,
    impressions: Math.round(num(r.impressions)),
    reach: Math.round(num(r.reach)),
    clicks: Math.round(num(r.clicks)),
    linkClicks: Math.round(num(r.inline_link_clicks)),
    purchases: Math.round(firstOf(r.actions, PURCHASE_TYPES)),
    purchaseValue: Math.round(firstOf(r.action_values, PURCHASE_TYPES) * 100) / 100,
    leads: Math.round(firstOf(r.actions, LEAD_TYPES)),
    messages: Math.round(firstOf(r.actions, MESSAGE_TYPES)),
  };
}

export function add(a: DayFigures, b: DayFigures): DayFigures {
  return {
    spend: Math.round((a.spend + b.spend) * 100) / 100,
    impressions: a.impressions + b.impressions,
    reach: a.reach + b.reach,
    clicks: a.clicks + b.clicks,
    linkClicks: a.linkClicks + b.linkClicks,
    purchases: a.purchases + b.purchases,
    purchaseValue: Math.round((a.purchaseValue + b.purchaseValue) * 100) / 100,
    leads: a.leads + b.leads,
    messages: a.messages + b.messages,
  };
}

export const resultsOf = (f: DayFigures): number => f.purchases + f.leads + f.messages;

const ratio = (a: number, b: number, scale = 1, digits = 2): number | null =>
  b > 0 ? Math.round((a / b) * scale * 10 ** digits) / 10 ** digits : null;

/** The ratios of Part 19. Reach summed over days counts a person more than once. */
export function metricsOf(f: DayFigures): AdMetrics {
  const results = resultsOf(f);
  return {
    ...f,
    results,
    ctr: ratio(f.clicks, f.impressions, 100),
    cpc: ratio(f.spend, f.clicks),
    cpm: ratio(f.spend, f.impressions, 1000),
    cpa: ratio(f.spend, results),
    roas: ratio(f.purchaseValue, f.spend),
  };
}

/** The date (YYYY-MM-DD) in a time zone, some days back. */
export function dayIn(timezone: string | null, now: Date, daysBack = 0): string {
  const at = new Date(now.getTime() - daysBack * 86_400_000);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Every date from `since` to `until`, so days without spend show as zero. */
export function daysBetween(since: string, until: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${until}T00:00:00Z`);
  for (let t = Date.parse(`${since}T00:00:00Z`); t <= end && out.length < 400; t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export function seriesOf(days: string[], byDay: Map<string, DayFigures>): AdDay[] {
  return days.map((day) => {
    const f = byDay.get(day) ?? ZERO;
    return {
      day,
      spend: f.spend,
      results: resultsOf(f),
      clicks: f.clicks,
      impressions: f.impressions,
    };
  });
}

// ---------------------------------------------------------------------------------- alerts

export interface CampaignForAlerts {
  id: string;
  name: string;
  effectiveStatus: string;
  /** Oldest first, the period plus the 7 days before it is fine; only the last 14 days are used. */
  days: { day: string; f: DayFigures }[];
}

export interface AccountForAlerts {
  id: string;
  name: string;
  accountStatus: number | null;
  currency: string | null;
  today: string;
  campaigns: CampaignForAlerts[];
  /** Disapproved ads, by campaign. */
  disapproved: { campaignId: string | null; campaignName: string | null; adName: string }[];
}

const MIN_IMPRESSIONS_CTR = 1000;
const SPIKE = 1.5;

const fmt = (n: number, currency: string | null) =>
  `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: currencyOffset(currency) === 1 ? 0 : 2 }).format(n)}${currency ? ` ${currency}` : ''}`;

/**
 * Unusual figures and suggestions (Part 19: anomaly alerts, optimisation proposals). They only
 * point things out: MARIS changes nothing by itself.
 */
export function alertsFor(a: AccountForAlerts): AdAlert[] {
  const out: AdAlert[] = [];
  const base = { accountId: a.id };
  if (a.accountStatus !== null && a.accountStatus !== 1)
    out.push({
      ...base,
      level: 'critical',
      code: 'ACCOUNT_NOT_ACTIVE',
      message: `Tài khoản quảng cáo “${a.name}” không ở trạng thái hoạt động (mã ${a.accountStatus}); quảng cáo không chạy được`,
      campaignId: null,
      campaignName: null,
    });
  for (const d of a.disapproved)
    out.push({
      ...base,
      level: 'critical',
      code: 'AD_DISAPPROVED',
      message: `Quảng cáo “${d.adName}” bị Meta từ chối. Sửa theo chính sách rồi gửi lại trong Trình quản lý quảng cáo; MARIS không tự gửi lại`,
      campaignId: d.campaignId,
      campaignName: d.campaignName,
    });

  for (const c of a.campaigns) {
    const last = c.days.slice(-14);
    const today = last.find((d) => d.day === a.today)?.f ?? null;
    const before = last.filter((d) => d.day < a.today).slice(-7);
    const sum = (list: { f: DayFigures }[]) => list.reduce((s, d) => add(s, d.f), ZERO);
    const at = { campaignId: c.id, campaignName: c.name };

    // Spend today well above the usual day (days with spend in the 7 before).
    const spentDays = before.filter((d) => d.f.spend > 0);
    if (today && spentDays.length >= 3) {
      const avg = sum(spentDays).spend / spentDays.length;
      if (avg > 0 && today.spend > avg * SPIKE)
        out.push({
          ...base,
          ...at,
          level: 'warning',
          code: 'SPEND_SPIKE',
          message: `“${c.name}” hôm nay đã chi ${fmt(today.spend, a.currency)}, hơn ${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(today.spend / avg)} lần mức trung bình ${fmt(Math.round(avg * 100) / 100, a.currency)}/ngày`,
        });
    }

    // Cost per result of the last 3 days against the 7 days before them.
    const recent = sum(last.slice(-3));
    const earlier = sum(last.slice(-10, -3));
    const cpaNow = metricsOf(recent).cpa;
    const cpaBefore = metricsOf(earlier).cpa;
    if (
      cpaNow !== null &&
      cpaBefore !== null &&
      resultsOf(earlier) >= 3 &&
      cpaNow > cpaBefore * SPIKE
    )
      out.push({
        ...base,
        ...at,
        level: 'warning',
        code: 'CPA_RISING',
        message: `Chi phí mỗi kết quả của “${c.name}” 3 ngày gần đây là ${fmt(cpaNow, a.currency)}, tăng từ ${fmt(cpaBefore, a.currency)}`,
      });

    const week = sum(last.slice(-7));
    if (week.spend > 0 && resultsOf(week) === 0 && week.clicks >= 50)
      out.push({
        ...base,
        ...at,
        level: 'warning',
        code: 'NO_RESULTS',
        message: `“${c.name}” đã chi ${fmt(week.spend, a.currency)} trong 7 ngày, ${week.clicks} lượt nhấp nhưng Meta chưa ghi nhận kết quả nào. Kiểm tra pixel, biểu mẫu hoặc trang đích`,
      });
    const ctr = metricsOf(week).ctr;
    if (ctr !== null && week.impressions >= MIN_IMPRESSIONS_CTR && ctr < 0.5)
      out.push({
        ...base,
        ...at,
        level: 'info',
        code: 'LOW_CTR',
        message: `CTR 7 ngày của “${c.name}” là ${ctr}% (dưới 0,5%). Đề xuất: thử nội dung hoặc hình ảnh mới, xem lại đối tượng`,
      });
    if (c.effectiveStatus === 'ACTIVE' && week.impressions === 0 && last.length > 0)
      out.push({
        ...base,
        ...at,
        level: 'info',
        code: 'NO_DELIVERY',
        message: `“${c.name}” đang bật nhưng 7 ngày chưa có lượt hiển thị. Kiểm tra nhóm quảng cáo, lịch chạy và ngân sách`,
      });
  }
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((x, y) => rank[x.level] - rank[y.level]);
}

// ---------------------------------------------------------------------------------- approval

/**
 * Whether a change needs a person with ads.approve (Part 19: never above the approved limit).
 * Pausing and lowering a budget never do. Raising a budget, or turning on something whose
 * daily budget is above the limit, does; with no limit set, every raise and turn-on does.
 */
export function needsApproval(
  change: { kind: 'status'; to: 'ACTIVE' | 'PAUSED' } | { kind: 'daily_budget'; to: number },
  current: { dailyBudget: number | null },
  capMinor: number | null,
): boolean {
  if (change.kind === 'status') {
    if (change.to === 'PAUSED') return false;
    if (capMinor === null) return true;
    return current.dailyBudget !== null && current.dailyBudget > capMinor;
  }
  if (current.dailyBudget !== null && change.to <= current.dailyBudget) return false;
  if (capMinor === null) return true;
  return change.to > capMinor;
}
