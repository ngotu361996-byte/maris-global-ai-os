import { z } from 'zod';

/**
 * Meta Ads Command Center (spec Part 19, M23) and spend analysis (Part 14). Campaigns, ad sets and
 * ads are read from each enabled ad account; daily figures are kept per campaign. Purchases and
 * their value are what Meta reports (pixel, Lead Ads, Messenger), not revenue the business has
 * received. MARIS never raises a daily budget above the limit approved for the account on its own.
 */

export const AD_LEVELS = ['campaign', 'adset', 'ad'] as const;
export type AdLevel = (typeof AD_LEVELS)[number];

export const AD_PERIODS = [7, 14, 30] as const;

/** Effective statuses Meta uses, in Vietnamese. Others are shown as they come. */
export const AD_STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Đang chạy',
  PAUSED: 'Tạm dừng',
  CAMPAIGN_PAUSED: 'Chiến dịch tạm dừng',
  ADSET_PAUSED: 'Nhóm quảng cáo tạm dừng',
  DELETED: 'Đã xóa',
  ARCHIVED: 'Lưu trữ',
  IN_PROCESS: 'Đang xử lý',
  PENDING_REVIEW: 'Chờ Meta duyệt',
  DISAPPROVED: 'Bị Meta từ chối',
  PREAPPROVED: 'Đã duyệt trước',
  PENDING_BILLING_INFO: 'Thiếu thông tin thanh toán',
  WITH_ISSUES: 'Có vấn đề',
};

/** Ad account status numbers Meta uses. */
export const AD_ACCOUNT_STATUS_LABEL: Record<number, string> = {
  1: 'Đang hoạt động',
  2: 'Bị vô hiệu hóa',
  3: 'Chưa thanh toán',
  7: 'Đang xem xét rủi ro',
  8: 'Chờ quyết toán',
  9: 'Trong thời gian ân hạn',
  100: 'Chờ đóng',
  101: 'Đã đóng',
  201: 'Hoạt động (bất kỳ)',
  202: 'Đã đóng (bất kỳ)',
};

export const listAdsSchema = z.object({
  accountId: z.uuid().optional(),
  days: z.coerce
    .number()
    .int()
    .refine((d) => (AD_PERIODS as readonly number[]).includes(d), 'Chọn 7, 14 hoặc 30 ngày')
    .default(7),
});
export type ListAds = z.infer<typeof listAdsSchema>;

export const setAdStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED']),
  reason: z.string().trim().max(500).default(''),
});
export type SetAdStatus = z.infer<typeof setAdStatusSchema>;

/** A new daily budget in major units of the account currency (VND, USD...). */
export const setAdBudgetSchema = z.object({
  dailyBudget: z.number().positive().max(1e12),
  reason: z.string().trim().max(500).default(''),
});
export type SetAdBudget = z.infer<typeof setAdBudgetSchema>;

/** The highest daily budget one campaign or ad set may have without approval; null = none. */
export const setAdAccountSchema = z.object({ dailyCap: z.number().min(0).max(1e12).nullable() });
export type SetAdAccount = z.infer<typeof setAdAccountSchema>;

export const decideAdChangeSchema = z.object({ note: z.string().trim().max(500).default('') });
export type DecideAdChange = z.infer<typeof decideAdChangeSchema>;

/** Totals over a period, with the ratios worked out from them (null when they cannot be). */
export interface AdMetrics {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  purchases: number;
  purchaseValue: number;
  leads: number;
  messages: number;
  /** Purchases + leads + Messenger conversations started. */
  results: number;
  /** Percent. */
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  /** Spend per result. */
  cpa: number | null;
  /** Purchase value reported by Meta / spend. */
  roas: number | null;
}

export interface AdDay {
  day: string;
  spend: number;
  results: number;
  clicks: number;
  impressions: number;
}

export type AdAlertLevel = 'critical' | 'warning' | 'info';
export interface AdAlert {
  level: AdAlertLevel;
  code: string;
  message: string;
  accountId: string;
  campaignId: string | null;
  campaignName: string | null;
}

export interface AdAccountResponse {
  id: string;
  externalId: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  accountStatus: number | null;
  accountStatusLabel: string | null;
  /** Major units, null = no limit set (every raise needs approval). */
  dailyCap: number | null;
  syncedAt: string | null;
  error: string | null;
  campaigns: number;
  activeCampaigns: number;
  metrics: AdMetrics;
}

export interface AdsSummaryResponse {
  ready: boolean;
  canManage: boolean;
  canApprove: boolean;
  missingScopes: string[];
  pollMinutes: number;
  days: number;
  accounts: AdAccountResponse[];
  /** Totals by currency, since accounts can differ. */
  totals: { currency: string; metrics: AdMetrics }[];
  series: AdDay[];
  alerts: AdAlert[];
  pendingChanges: number;
}

export interface AdObjectResponse {
  id: string;
  accountId: string;
  level: AdLevel;
  externalId: string;
  name: string;
  status: string;
  effectiveStatus: string;
  statusLabel: string;
  objective: string | null;
  /** Major units. */
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  currency: string | null;
  present: boolean;
  campaignId: string | null;
  adsetId: string | null;
  /** Campaigns only. */
  metrics: AdMetrics | null;
  /** An open change waiting for approval or being sent. */
  openChange: {
    id: string;
    kind: 'status' | 'daily_budget';
    toValue: string;
    status: string;
  } | null;
}

export interface CampaignDetail extends AdObjectResponse {
  series: AdDay[];
  adsets: AdObjectResponse[];
  ads: AdObjectResponse[];
}

export interface AdChangeResponse {
  id: string;
  objectId: string;
  objectName: string;
  level: AdLevel;
  accountName: string;
  currency: string | null;
  kind: 'status' | 'daily_budget';
  /** Status, or a budget in major units. */
  fromValue: string | null;
  toValue: string;
  reason: string;
  status: 'pending' | 'applying' | 'applied' | 'failed' | 'rejected' | 'cancelled';
  needsApproval: boolean;
  requestedByName: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

export interface AdSyncResponse {
  accounts: number;
  campaigns: number;
  days: number;
  errors: string[];
}
