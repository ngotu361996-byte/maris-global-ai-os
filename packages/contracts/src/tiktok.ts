import { z } from 'zod';

/**
 * TikTok Center (spec Part 17, M19), Phase 8. A tenant uses its own TikTok for Developers app: the
 * client key here, the client secret in the Secret Vault. Each service is asked for on its own and
 * a feature is ready only when TikTok granted its scopes.
 *
 * Posting follows TikTok's Content Sharing Guidelines: the creator's own privacy options with no
 * default, interactions off unless chosen, a disclosure for commercial content, and the consent to
 * TikTok's Music Usage Confirmation before every post.
 *
 * The limits are MARIS's own product limits for the BUSINESS plan, not promises from TikTok.
 */
export const TIKTOK_LIMITS = {
  /** TikTok accounts signed in at once. */
  accounts: 10,
  /**
   * Posts MARIS sends to one account in 24 hours. TikTok caps posts made through the API per
   * creator (about 15 a day, varying by creator); MARIS stops before that.
   */
  postsPerDay: 15,
} as const;

/** Asked every time, so MARIS knows who signed in. */
export const TIKTOK_BASE_SCOPES = ['user.info.basic'] as const;

export const TIKTOK_SERVICES = {
  publish: { label: 'Đăng thẳng lên trang cá nhân', scopes: ['video.publish'] },
  draft: { label: 'Gửi vào hộp nháp TikTok', scopes: ['video.upload'] },
  insights: {
    label: 'Số liệu tài khoản và video',
    scopes: ['user.info.profile', 'user.info.stats', 'video.list'],
  },
} as const;
export type TiktokService = keyof typeof TIKTOK_SERVICES;
export const TIKTOK_SERVICE_KEYS = Object.keys(TIKTOK_SERVICES) as [TiktokService, ...TiktokService[]];

export const TIKTOK_FEATURES = [
  { key: 'profile', label: 'Xem hồ sơ', scopes: ['user.info.basic'] },
  { key: 'direct', label: 'Đăng video thẳng lên TikTok', scopes: ['video.publish'] },
  { key: 'draft', label: 'Gửi video vào hộp nháp', scopes: ['video.upload'] },
  {
    key: 'insights',
    label: 'Số liệu tài khoản và video',
    scopes: ['user.info.profile', 'user.info.stats', 'video.list'],
  },
] as const;

export const setTiktokAppSchema = z.object({
  clientKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{8,64}$/, 'Client key gồm chữ và số, như trong TikTok for Developers'),
  clientSecretName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/),
  /**
   * TikTok has audited the app for Direct Post. Until then TikTok only lets it post as "only me"
   * (SELF_ONLY), so MARIS asks for that and says so.
   */
  audited: z.boolean().default(false),
});
export type SetTiktokApp = z.infer<typeof setTiktokAppSchema>;

export const tiktokOauthStartSchema = z.object({
  services: z.array(z.enum(TIKTOK_SERVICE_KEYS)).min(1),
});
export type TiktokOauthStart = z.infer<typeof tiktokOauthStartSchema>;

export const tiktokCallbackSchema = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type TiktokCallback = z.infer<typeof tiktokCallbackSchema>;

export const updateTiktokAccountSchema = z.object({ enabled: z.boolean() });
export type UpdateTiktokAccount = z.infer<typeof updateTiktokAccountSchema>;

export const TIKTOK_PRIVACY = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;
export type TiktokPrivacy = (typeof TIKTOK_PRIVACY)[number];
export const TIKTOK_PRIVACY_LABEL: Record<TiktokPrivacy, string> = {
  PUBLIC_TO_EVERYONE: 'Mọi người',
  MUTUAL_FOLLOW_FRIENDS: 'Bạn bè (theo dõi lẫn nhau)',
  FOLLOWER_OF_CREATOR: 'Người theo dõi',
  SELF_ONLY: 'Chỉ mình tôi',
};

export interface TiktokAppResponse {
  clientKey: string;
  clientSecretName: string;
  secretFound: boolean;
  audited: boolean;
}

export interface TiktokCreatorResponse {
  nickname: string | null;
  username: string | null;
  /** The privacy choices TikTok offers this creator now. */
  privacyOptions: TiktokPrivacy[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  /** The longest video this creator may post, in seconds. */
  maxDurationSec: number | null;
  checkedAt: string;
}

export interface TiktokAccountResponse {
  id: string;
  openId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  status: 'active' | 'invalid';
  enabled: boolean;
  scopes: string[];
  features: { key: string; label: string; ready: boolean }[];
  followers: number | null;
  following: number | null;
  likes: number | null;
  videoCount: number | null;
  creator: TiktokCreatorResponse | null;
  /** Posts sent in the last 24 hours, against TIKTOK_LIMITS.postsPerDay. */
  postsToday: number;
  checkError: string | null;
  connectedByName: string;
  connectedAt: string;
  syncedAt: string | null;
  /** When TikTok stops accepting the refresh token (365 days after sign-in). */
  refreshExpiresAt: string | null;
}

export interface TiktokStatusResponse {
  app: TiktokAppResponse | null;
  /** Add this to the Redirect URI list of Login Kit in TikTok for Developers. */
  redirectUri: string;
  accounts: TiktokAccountResponse[];
}

export interface TiktokOauthStartResponse {
  url: string;
}

// ---------------------------------------------------------------- posts

export const TIKTOK_MODES = ['direct', 'draft'] as const;
export type TiktokMode = (typeof TIKTOK_MODES)[number];
export const TIKTOK_MODE_LABEL: Record<TiktokMode, string> = {
  direct: 'Đăng thẳng',
  draft: 'Gửi vào hộp nháp',
};

/** What TikTok accepts for a video post, and what MARIS checks first. */
export const TIKTOK_RULES = {
  /** Caption with hashtags and mentions, in UTF-16 code units. */
  titleMaxChars: 2200,
  minSec: 3,
  videoMaxMb: 4096,
  mimes: ['video/mp4', 'video/quicktime', 'video/webm'],
  /** TikTok has no scheduled posting: MARIS holds the post and sends it at the time. */
  maxAheadDays: 30,
} as const;

export const TIKTOK_POST_STATUSES = [
  'scheduled',
  'uploading',
  'processing',
  'published',
  'in_inbox',
  'failed',
  'cancelled',
] as const;
export type TiktokPostStatus = (typeof TIKTOK_POST_STATUSES)[number];
export const TIKTOK_POST_STATUS_LABEL: Record<TiktokPostStatus, string> = {
  scheduled: 'Chờ đăng',
  uploading: 'Đang tải lên',
  processing: 'TikTok đang xử lý',
  published: 'Đã đăng',
  in_inbox: 'Đã vào hộp nháp',
  failed: 'Lỗi, chờ xử lý',
  cancelled: 'Đã hủy',
};

export const scheduleTiktokSchema = z
  .object({
    itemId: z.uuid(),
    accountIds: z.array(z.uuid()).min(1).max(TIKTOK_LIMITS.accounts),
    mode: z.enum(TIKTOK_MODES),
    /** The caption. Draft posts ignore it: the creator writes it in the TikTok app. */
    title: z.string().trim().max(TIKTOK_RULES.titleMaxChars).default(''),
    /** Required for Direct Post, with no default (TikTok's guidelines). */
    privacy: z.enum(TIKTOK_PRIVACY).nullable().default(null),
    allowComment: z.boolean().default(false),
    allowDuet: z.boolean().default(false),
    allowStitch: z.boolean().default(false),
    /** Promotes the creator's own business ("Your brand"). */
    brandOrganic: z.boolean().default(false),
    /** A paid partnership ("Branded content"); cannot be "only me". */
    brandedContent: z.boolean().default(false),
    /** The video is made or edited with AI. */
    aigc: z.boolean().default(false),
    /** The frame used as cover, in milliseconds from the start. */
    coverMs: z.number().int().min(0).max(36_000_000).default(0),
    /** When MARIS sends the post; null means now. */
    at: z.iso.datetime({ offset: true }).nullable().default(null),
    /** The person agreed to TikTok's Music Usage Confirmation (and Branded Content Policy). */
    consent: z.literal(true),
  })
  .refine((v) => v.mode === 'draft' || v.privacy !== null, {
    message: 'Chọn ai được xem video',
    path: ['privacy'],
  })
  .refine((v) => !(v.brandedContent && v.privacy === 'SELF_ONLY'), {
    message: 'Nội dung hợp tác có trả phí không để chế độ Chỉ mình tôi',
    path: ['privacy'],
  });
export type ScheduleTiktok = z.infer<typeof scheduleTiktokSchema>;

export const listTiktokPostsSchema = z.object({
  status: z.enum(TIKTOK_POST_STATUSES).optional(),
  itemId: z.uuid().optional(),
});
export type ListTiktokPosts = z.infer<typeof listTiktokPostsSchema>;

export interface TiktokPostResponse {
  id: string;
  itemId: string;
  itemTitle: string;
  version: number;
  accountId: string;
  accountName: string;
  mode: TiktokMode;
  title: string;
  privacy: TiktokPrivacy | null;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  brandOrganic: boolean;
  brandedContent: boolean;
  aigc: boolean;
  scheduledAt: string;
  status: TiktokPostStatus;
  attempts: number;
  /** Share of the file TikTok has, while uploading. */
  uploadedPct: number | null;
  postId: string | null;
  url: string | null;
  warnings: string[];
  errorCode: string | null;
  errorMessage: string | null;
  createdByName: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface TiktokVideoResponse {
  id: string;
  accountId: string;
  accountName: string;
  videoId: string;
  title: string;
  coverUrl: string | null;
  shareUrl: string | null;
  postedAt: string | null;
  durationSec: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  syncedAt: string;
}

export interface TiktokReportResponse {
  /** Over the videos MARIS has read, posted in the last `days` days. */
  days: number;
  videos: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /** (likes + comments + shares) / views, in percent. */
  engagementPct: number | null;
  top: TiktokVideoResponse[];
}
