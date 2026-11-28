import { z } from 'zod';

/**
 * Meta Control Center (spec Part 14) and the API Governor (Part 15). The limits are MARIS's own
 * product limits for the BUSINESS plan, not limits or safety promises from Meta.
 */
export const META_LIMITS = {
  pages: 20,
  adAccounts: 10,
  repliesPerDay: 400,
  postsPerPagePerDay: 3,
  postsPerDay: 60,
  apiCallsPerDay: 3000,
} as const;

export const META_DEFAULT_GRAPH_VERSION = 'v23.0';

/** API groups and their default daily budget (Part 15). Total 3,000 calls. */
export const API_GROUPS = [
  'reply',
  'lookup',
  'publish',
  'page_insights',
  'ads_insights',
  'ads_manage',
  'sync',
  'reserve',
] as const;
export type ApiGroup = (typeof API_GROUPS)[number];

export const API_GROUP_INFO: Record<ApiGroup, { label: string; budget: number }> = {
  reply: { label: 'Trả lời khách hàng', budget: 400 },
  lookup: { label: 'Tra cứu bổ sung', budget: 100 },
  publish: { label: 'Xuất bản và trạng thái', budget: 240 },
  page_insights: { label: 'Phân tích Page và nội dung', budget: 680 },
  ads_insights: { label: 'Phân tích quảng cáo', budget: 480 },
  ads_manage: { label: 'Quản lý quảng cáo', budget: 200 },
  sync: { label: 'Đồng bộ tài sản', budget: 100 },
  reserve: { label: 'Dự phòng', budget: 800 },
};

/**
 * How urgent a call is. Essential calls (a customer reply, a scheduled post, signing in) keep
 * going longest; background calls (sync, analysis) are put off first.
 */
export type ApiPriority = 'essential' | 'normal' | 'background';

/** Internal thresholds of Part 15, by the share of the budget used. */
export const GOVERNOR_LEVELS = [
  { from: 0, label: 'Hoạt động bình thường' },
  { from: 50, label: 'Tăng cache' },
  { from: 65, label: 'Giảm tần suất phân tích' },
  { from: 75, label: 'Hoãn đồng bộ không cần thiết' },
  { from: 85, label: 'Chỉ việc thiết yếu' },
  { from: 90, label: 'Tạm dừng nhóm API' },
] as const;

/** Permissions MARIS asks Meta for, and what each one is needed for. */
export const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_read_user_content',
  'pages_messaging',
  'read_insights',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_messages',
  'leads_retrieval',
  'pages_manage_ads',
  'ads_read',
  'ads_management',
  'business_management',
] as const;

export const META_FEATURES = [
  { key: 'pages', label: 'Xem Page', scopes: ['pages_show_list'] },
  {
    key: 'publish',
    label: 'Đăng bài lên Page',
    scopes: ['pages_manage_posts', 'pages_read_engagement'],
  },
  {
    key: 'instagram',
    label: 'Đăng lên Instagram',
    scopes: ['instagram_basic', 'instagram_content_publish'],
  },
  {
    key: 'comments',
    label: 'Bình luận Facebook và Instagram',
    scopes: ['pages_manage_engagement', 'pages_read_user_content', 'instagram_manage_comments'],
  },
  {
    key: 'messages',
    label: 'Messenger và tin nhắn Instagram',
    scopes: ['pages_messaging', 'instagram_manage_messages', 'pages_manage_metadata'],
  },
  { key: 'insights', label: 'Phân tích Page', scopes: ['read_insights'] },
  { key: 'leads', label: 'Lead Ads', scopes: ['leads_retrieval', 'pages_manage_ads'] },
  { key: 'ads_read', label: 'Xem quảng cáo và chi tiêu', scopes: ['ads_read'] },
  { key: 'ads_manage', label: 'Quản lý quảng cáo', scopes: ['ads_management'] },
] as const;

export const setMetaAppSchema = z.object({
  appId: z.string().regex(/^[0-9]{5,20}$/, 'App ID là dãy số'),
  appSecretName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/),
  graphVersion: z
    .string()
    .regex(/^v[0-9]{2}\.0$/, 'dạng v23.0')
    .default(META_DEFAULT_GRAPH_VERSION),
  budgets: z.partialRecord(z.enum(API_GROUPS), z.number().int().min(0).max(100_000)).default({}),
});
export type SetMetaApp = z.infer<typeof setMetaAppSchema>;

export const metaCallbackSchema = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type MetaCallback = z.infer<typeof metaCallbackSchema>;

export const updateMetaAssetSchema = z.object({ enabled: z.boolean() });
export type UpdateMetaAsset = z.infer<typeof updateMetaAssetSchema>;

export type MetaAssetKind = 'page' | 'instagram' | 'ad_account';

export interface MetaAssetResponse {
  id: string;
  kind: MetaAssetKind;
  externalId: string;
  name: string;
  username: string | null;
  category: string | null;
  pageId: string | null;
  currency: string | null;
  timezone: string | null;
  accountStatus: number | null;
  tasks: string[];
  enabled: boolean;
  removed: boolean;
  syncedAt: string;
}

export interface MetaConnectionResponse {
  id: string;
  fbUserId: string;
  fbName: string;
  status: 'active' | 'expired' | 'invalid';
  tokenExpiresAt: string | null;
  scopes: string[];
  declined: string[];
  checkError: string | null;
  connectedByName: string;
  connectedAt: string;
  checkedAt: string | null;
  syncedAt: string | null;
}

export type GovernorGroupState = 'ok' | 'essential_only' | 'no_background' | 'paused' | 'blocked';

export interface GovernorGroupResponse {
  group: ApiGroup;
  label: string;
  used: number;
  budget: number;
  pct: number;
  state: GovernorGroupState;
  blockedUntil: string | null;
}

/** Meta's own usage figures from the last response headers, or why they are not known. */
export interface PlatformUsage {
  status: 'known' | 'unknown' | 'stale';
  /** Highest share of any Meta limit in the last headers, 0–100. */
  pct: number | null;
  at: string | null;
  detail: {
    header: string;
    key: string;
    callCount: number | null;
    totalTime: number | null;
    totalCputime: number | null;
  }[];
}

export interface GovernorResponse {
  windowHours: 24;
  used: number;
  budget: number;
  pct: number;
  level: string;
  cacheHits: number;
  groups: GovernorGroupResponse[];
  platform: PlatformUsage;
  blockedUntil: string | null;
}

export interface MetaAppResponse {
  appId: string;
  appSecretName: string;
  secretFound: boolean;
  graphVersion: string;
  redirectUri: string;
  budgets: Partial<Record<ApiGroup, number>>;
}

export interface MetaFeatureResponse {
  key: string;
  label: string;
  ready: boolean;
  missing: string[];
}

export interface MetaStatusResponse {
  app: MetaAppResponse | null;
  /** Where Meta sends the person back to after sign-in; add it to the Meta App. */
  redirectUri: string;
  connection: MetaConnectionResponse | null;
  features: MetaFeatureResponse[];
  assets: MetaAssetResponse[];
  governor: GovernorResponse;
}

export interface MetaOauthStartResponse {
  url: string;
}

export interface ApiCallResponse {
  id: string;
  group: string;
  method: string;
  path: string;
  outcome: 'ok' | 'failed' | 'refused';
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  /** Google: quota units the call counted for. */
  units?: number | null;
  calledByName: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- Publishing (Sprint 22)

export const META_POST_FORMATS = ['feed', 'photo', 'video', 'reel', 'ig_image', 'ig_reel'] as const;
export type MetaPostFormat = (typeof META_POST_FORMATS)[number];

export const META_POST_FORMAT_LABEL: Record<MetaPostFormat, string> = {
  feed: 'Bài viết trên Page',
  photo: 'Ảnh trên Page',
  video: 'Video trên Page',
  reel: 'Reels trên Page',
  ig_image: 'Ảnh Instagram',
  ig_reel: 'Reels Instagram',
};

export const META_POST_STATUSES = [
  'scheduled',
  'publishing',
  'processing',
  'published',
  'failed',
  'cancelled',
] as const;
export type MetaPostStatus = (typeof META_POST_STATUSES)[number];

export const META_POST_STATUS_LABEL: Record<MetaPostStatus, string> = {
  scheduled: 'Đã lên lịch',
  publishing: 'Đang đăng',
  processing: 'Meta đang xử lý',
  published: 'Đã đăng',
  failed: 'Lỗi, chờ xử lý',
  cancelled: 'Đã hủy',
};

/** Suggested publishing times in the market's time zone (3 slots a day, Part 15). */
export const META_POST_SLOTS = ['09:00', '12:00', '20:00'] as const;

/** Reels length that Meta accepts, in seconds. */
export const META_REEL_SECONDS = {
  page: { min: 3, max: 90 },
  instagram: { min: 3, max: 900 },
} as const;
export const META_MEDIA_MAX_MB = { photo: 10, video: 1024 } as const;

export const scheduleMetaPostSchema = z.object({
  itemId: z.uuid(),
  assetIds: z
    .array(z.uuid())
    .min(1)
    .max(META_LIMITS.pages * 2),
  /** For a video on a Page: a normal video or Reels. */
  videoAs: z.enum(['video', 'reel']).default('reel'),
  /** For photos and videos; a text item is posted as its own words. */
  caption: z.string().trim().max(63206).nullable().default(null),
  link: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullable()
    .default(null),
  /** When to post; null means now. */
  at: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type ScheduleMetaPost = z.infer<typeof scheduleMetaPostSchema>;

export const listMetaPostsSchema = z.object({
  status: z.enum(META_POST_STATUSES).optional(),
  itemId: z.uuid().optional(),
});
export type ListMetaPosts = z.infer<typeof listMetaPostsSchema>;

export interface MetaPostResponse {
  id: string;
  itemId: string;
  itemTitle: string;
  version: number;
  assetId: string;
  assetName: string;
  assetKind: MetaAssetKind;
  format: MetaPostFormat;
  caption: string | null;
  link: string | null;
  scheduledAt: string;
  localDay: string;
  status: MetaPostStatus;
  attempts: number;
  nextAttemptAt: string | null;
  externalId: string | null;
  permalink: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdByName: string;
  createdAt: string;
  publishedAt: string | null;
}

// ---------------------------------------------------------------- Inbox (Sprint 23)

export const META_CHANNELS = ['messenger', 'ig_dm', 'fb_comment', 'ig_comment'] as const;
export type MetaChannel = (typeof META_CHANNELS)[number];
export const META_CHANNEL_LABEL: Record<MetaChannel, string> = {
  messenger: 'Messenger',
  ig_dm: 'Tin nhắn Instagram',
  fb_comment: 'Bình luận Facebook',
  ig_comment: 'Bình luận Instagram',
};
/** Messenger and Instagram allow a business reply this long after the customer's last message. */
export const META_REPLY_WINDOW_HOURS = 24;
export const META_REPLY_MAX_CHARS = 2000;

export const listInboxSchema = z.object({
  status: z.enum(['open', 'done']).optional(),
  channel: z.enum(META_CHANNELS).optional(),
  assetId: z.uuid().optional(),
  /** "me": assigned to the person asking; "none": not assigned. */
  assigned: z.enum(['me', 'none']).optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListInbox = z.infer<typeof listInboxSchema>;

export const replyInboxSchema = z.object({
  text: z.string().trim().min(1).max(META_REPLY_MAX_CHARS),
  /** A random id from the browser, so a double click sends once. */
  clientKey: z.uuid(),
  /** The text started from MARIS's AI suggestion. */
  aiAssisted: z.boolean().default(false),
});
export type ReplyInbox = z.infer<typeof replyInboxSchema>;

export const updateThreadSchema = z
  .object({
    status: z.enum(['open', 'done']).optional(),
    assignedTo: z.uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assignedTo !== undefined, {
    message: 'Không có gì để đổi',
  });
export type UpdateThread = z.infer<typeof updateThreadSchema>;

export interface InboxThreadResponse {
  id: string;
  channel: MetaChannel;
  assetId: string;
  assetName: string;
  customerName: string;
  status: 'open' | 'done';
  assignedTo: string | null;
  assignedToName: string | null;
  unread: number;
  snippet: string;
  lastMessageAt: string;
  /** Messenger and Instagram: until when a reply is still allowed; null for comments. */
  replyUntil: string | null;
  /** The CRM contact this conversation belongs to (Sprint 24). */
  contactId: string | null;
  contactName: string | null;
}

export interface InboxMessageResponse {
  id: string;
  direction: 'in' | 'out';
  authorName: string;
  body: string;
  attachments: { type: string; url: string | null }[];
  status: 'received' | 'sending' | 'sent' | 'failed' | 'unknown';
  sentAt: string;
  sentByName: string | null;
  aiAssisted: boolean;
  errorMessage: string | null;
}

export interface InboxThreadDetail extends InboxThreadResponse {
  postId: string | null;
  messages: InboxMessageResponse[];
  suggestion: { text: string; handoff: boolean; reason: string | null; at: string } | null;
}

export interface InboxSummaryResponse {
  open: number;
  unread: number;
  repliesToday: number;
  replyLimit: number;
  webhook: {
    callbackUrl: string;
    verifyToken: string | null;
    lastEventAt: string | null;
  };
  /** Minutes between reads when the webhook is quiet; 0 when reading is off. */
  pollMinutes: number;
  lastPolledAt: string | null;
}
