import { z } from 'zod';

/**
 * Website and SEO Center (spec Part 16: Google Analytics 4 and Search Console; Part 18: website
 * checks; M21), Phase 8. GA4 and Search Console are read through a Google account signed in on the
 * Google Center with the matching service; MARIS only reads. Website checks read public pages.
 *
 * The limits are MARIS's own product limits, not promises from Google.
 */
export const WEB_LIMITS = {
  sites: 20,
  /** Days of GA4 and Search Console numbers read each time. */
  days: 28,
  /** Rows kept for each top list. */
  tops: 20,
  /** Pages one website check reads, and links it tests. */
  checkPages: 25,
  checkLinks: 150,
  /** A page slower than this (ms) is flagged. */
  slowMs: 3000,
} as const;

export const WEB_TOP_KINDS = ['ga4_page', 'ga4_channel', 'gsc_query', 'gsc_page'] as const;
export type WebTopKind = (typeof WEB_TOP_KINDS)[number];

/** Problems a website check reports, with their Vietnamese names. */
export const WEB_ISSUE_LABEL: Record<string, string> = {
  http_error: 'Trang trả lỗi',
  unreachable: 'Không mở được trang',
  broken_link: 'Liên kết hỏng',
  redirect_loop: 'Chuyển hướng quá nhiều lần',
  no_https: 'Chưa dùng HTTPS',
  slow: 'Trang chậm',
  missing_title: 'Thiếu thẻ title',
  long_title: 'Title quá dài',
  duplicate_title: 'Title trùng trang khác',
  missing_description: 'Thiếu meta description',
  long_description: 'Meta description quá dài',
  missing_h1: 'Thiếu thẻ H1',
  many_h1: 'Nhiều thẻ H1',
  noindex: 'Trang chặn Google lập chỉ mục (noindex)',
  missing_viewport: 'Thiếu thẻ viewport cho điện thoại',
  missing_lang: 'Thiếu thuộc tính lang',
  images_no_alt: 'Ảnh thiếu alt',
  no_sitemap: 'Không thấy sitemap.xml',
  no_robots: 'Không thấy robots.txt',
};

/** The home page of a site: http(s), host only, ending in "/". */
export function siteUrl(raw: string): string | null {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password || (!u.hostname.includes('.') && u.hostname !== 'localhost')) return null;
  return `${u.protocol}//${u.host}/`.toLowerCase();
}

const siteUrlSchema = z
  .string()
  .max(300)
  .transform((v, ctx) => {
    const u = siteUrl(v);
    if (!u) ctx.addIssue({ code: 'custom', message: 'Địa chỉ website dạng https://ten-mien.vn' });
    return u ?? '';
  });

export const createSiteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: siteUrlSchema,
});
export type CreateSite = z.infer<typeof createSiteSchema>;

export const updateSiteSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    /** Null unlinks GA4. */
    ga4: z
      .object({
        connectionId: z.uuid(),
        property: z.string().regex(/^properties\/[0-9]{1,20}$/),
      })
      .nullable()
      .optional(),
    /** Null unlinks Search Console. */
    gsc: z
      .object({
        connectionId: z.uuid(),
        site: z
          .string()
          .min(1)
          .max(300)
          .regex(/^(sc-domain:[a-z0-9.-]+|https?:\/\/\S+\/)$/, 'Thuộc tính Search Console không hợp lệ'),
      })
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Không có gì để đổi');
export type UpdateSite = z.infer<typeof updateSiteSchema>;

export const webGooglePropertiesSchema = z.object({ connectionId: z.uuid() });

export const webReportSchema = z.object({
  siteId: z.uuid(),
  days: z.coerce.number().int().min(7).max(90).default(28),
});

export interface WebSiteResponse {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  ga4: { property: string; name: string | null; connectionId: string; connectionEmail: string } | null;
  gsc: { site: string; connectionId: string; connectionEmail: string } | null;
  sitemaps: {
    path: string;
    lastDownloaded: string | null;
    isPending: boolean;
    errors: number;
    warnings: number;
    submitted: number | null;
    indexed: number | null;
  }[];
  syncedAt: string | null;
  syncError: string | null;
  lastCheck: WebCheckResponse | null;
  createdByName: string;
  createdAt: string;
}

/** A Google account on the Google Center, and whether it can read GA4 and Search Console. */
export interface WebGoogleAccount {
  id: string;
  email: string;
  analytics: boolean;
  searchConsole: boolean;
}

export interface WebStatusResponse {
  sites: WebSiteResponse[];
  accounts: WebGoogleAccount[];
  syncEveryHours: number;
}

export interface Ga4PropertyResponse {
  property: string;
  name: string;
  account: string;
}

export interface GscSiteResponse {
  site: string;
  permission: string;
}

export interface WebDayResponse {
  day: string;
  sessions: number | null;
  users: number | null;
  views: number | null;
  keyEvents: number | null;
  clicks: number | null;
  impressions: number | null;
  position: number | null;
}

export interface WebReportResponse {
  siteId: string;
  days: number;
  totals: {
    sessions: number;
    users: number;
    newUsers: number;
    views: number;
    keyEvents: number;
    engagementRate: number | null;
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
  };
  /** The same totals for the days before, to show the change. */
  before: { sessions: number; clicks: number; impressions: number; keyEvents: number };
  daily: WebDayResponse[];
  /** ga4_page: a views, b users. ga4_channel: a sessions, b key events. gsc_*: a clicks, b impressions, c ctr, d position. */
  tops: Record<WebTopKind, { key: string; a: number; b: number; c: number; d: number }[]>;
}

export interface WebIssueResponse {
  severity: 'error' | 'warning';
  kind: string;
  url: string;
  detail: string;
}

export interface WebCheckResponse {
  id: string;
  siteId: string;
  status: 'running' | 'done' | 'failed';
  pages: number;
  links: number;
  errors: number;
  warnings: number;
  avgMs: number | null;
  maxMs: number | null;
  error: string | null;
  requestedByName: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface WebCheckDetailResponse extends WebCheckResponse {
  issues: WebIssueResponse[];
}

export interface WebSyncResponse {
  sites: number;
  days: number;
  errors: string[];
}
