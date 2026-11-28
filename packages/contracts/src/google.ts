import { z } from 'zod';

/**
 * Google Center (spec Part 16) and YouTube Center (Part 17), Phase 8. A tenant uses its own Google
 * Cloud project: the OAuth client ID here, the client secret in the Secret Vault. Each Google
 * service is asked for separately, and a feature is ready only when Google granted its scopes:
 * no Google account is assumed to have every API.
 *
 * The limits are MARIS's own product limits for the BUSINESS plan, not promises from Google.
 */
export const GOOGLE_LIMITS = {
  /** Google accounts signed in at once (one per YouTube channel or brand account). */
  connections: 10,
  /** YouTube channels turned on. */
  channels: 10,
} as const;

/** Sign-in scopes asked every time, so MARIS knows which Google account signed in. */
export const GOOGLE_BASE_SCOPES = ['openid', 'email', 'profile'] as const;

/** Google services a tenant can ask for, each with the scopes it needs. */
export const GOOGLE_SERVICES = {
  youtube: {
    label: 'YouTube',
    scopes: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.upload',
    ],
  },
} as const;
export type GoogleService = keyof typeof GOOGLE_SERVICES;
export const GOOGLE_SERVICE_KEYS = Object.keys(GOOGLE_SERVICES) as [GoogleService];

export const GOOGLE_FEATURES = [
  {
    key: 'youtube_read',
    label: 'Xem kênh YouTube',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
  },
  {
    key: 'youtube_upload',
    label: 'Tải video và Shorts lên YouTube',
    scopes: ['https://www.googleapis.com/auth/youtube.upload'],
  },
] as const;

/**
 * YouTube Data API quota: 10,000 units a day for a new Google Cloud project, counted from
 * midnight Pacific time. Costs per call from Google's quota table; an upload is the costly one.
 */
export const YOUTUBE_DEFAULT_QUOTA = 10_000;
export const YOUTUBE_QUOTA_TIMEZONE = 'America/Los_Angeles';
export const YOUTUBE_COSTS = {
  list: 1,
  upload: 1600,
  thumbnail: 50,
  update: 50,
} as const;
export type YoutubeCall = keyof typeof YOUTUBE_COSTS;

export const setGoogleAppSchema = z.object({
  clientId: z
    .string()
    .trim()
    .regex(
      /^[0-9]{5,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/,
      'Client ID dạng 1234-abc.apps.googleusercontent.com',
    ),
  clientSecretName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/),
  /** Units a day the Google Cloud project has for the YouTube Data API. */
  youtubeQuota: z.number().int().min(100).max(10_000_000).default(YOUTUBE_DEFAULT_QUOTA),
  /**
   * Google has audited the project for the YouTube API. Until then YouTube keeps videos uploaded
   * through the API private, so MARIS uploads them as private and says so.
   */
  youtubeAudited: z.boolean().default(false),
});
export type SetGoogleApp = z.infer<typeof setGoogleAppSchema>;

export const googleOauthStartSchema = z.object({
  services: z.array(z.enum(GOOGLE_SERVICE_KEYS)).min(1),
});
export type GoogleOauthStart = z.infer<typeof googleOauthStartSchema>;

export const googleCallbackSchema = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type GoogleCallback = z.infer<typeof googleCallbackSchema>;

export const updateYoutubeChannelSchema = z.object({ enabled: z.boolean() });
export type UpdateYoutubeChannel = z.infer<typeof updateYoutubeChannelSchema>;

export interface GoogleAppResponse {
  clientId: string;
  clientSecretName: string;
  secretFound: boolean;
  youtubeQuota: number;
  youtubeAudited: boolean;
}

export interface GoogleConnectionResponse {
  id: string;
  email: string;
  name: string;
  status: 'active' | 'invalid';
  scopes: string[];
  features: { key: string; label: string; ready: boolean }[];
  checkError: string | null;
  connectedByName: string;
  connectedAt: string;
  syncedAt: string | null;
}

export interface YoutubeChannelResponse {
  id: string;
  connectionId: string;
  connectionEmail: string;
  channelId: string;
  title: string;
  customUrl: string | null;
  thumbnailUrl: string | null;
  subscribers: number | null;
  videos: number | null;
  views: number | null;
  /** YouTube's own flags: channels that are not verified cannot upload long videos or thumbnails. */
  longUploads: string | null;
  enabled: boolean;
  removed: boolean;
  syncedAt: string;
}

export interface QuotaResponse {
  service: 'youtube';
  used: number;
  quota: number;
  pct: number;
  /** The state the API Governor rules (Part 15) give at this share. */
  state: 'ok' | 'no_background' | 'essential_only' | 'paused' | 'blocked';
  level: string;
  /** Midnight Pacific time, when Google starts the count again. */
  resetsAt: string;
  blockedUntil: string | null;
}

export interface GoogleStatusResponse {
  app: GoogleAppResponse | null;
  /** Add this to "Authorized redirect URIs" of the OAuth client. */
  redirectUri: string;
  connections: GoogleConnectionResponse[];
  channels: YoutubeChannelResponse[];
  quota: QuotaResponse;
}

export interface GoogleOauthStartResponse {
  url: string;
}

// ---------------------------------------------------------------- YouTube uploads

export const YOUTUBE_FORMATS = ['video', 'short'] as const;
export type YoutubeFormat = (typeof YOUTUBE_FORMATS)[number];
export const YOUTUBE_FORMAT_LABEL: Record<YoutubeFormat, string> = {
  video: 'Video YouTube',
  short: 'YouTube Shorts',
};

export const YOUTUBE_PRIVACY = ['public', 'unlisted', 'private'] as const;
export type YoutubePrivacy = (typeof YOUTUBE_PRIVACY)[number];
export const YOUTUBE_PRIVACY_LABEL: Record<YoutubePrivacy, string> = {
  public: 'Công khai',
  unlisted: 'Không công khai (ai có đường dẫn mới xem)',
  private: 'Riêng tư',
};

/** YouTube's video categories that apply in most regions. */
export const YOUTUBE_CATEGORIES = {
  '1': 'Phim và hoạt hình',
  '2': 'Ô tô và xe cộ',
  '10': 'Âm nhạc',
  '15': 'Thú cưng và động vật',
  '17': 'Thể thao',
  '19': 'Du lịch và sự kiện',
  '20': 'Trò chơi',
  '22': 'Mọi người và blog',
  '23': 'Hài kịch',
  '24': 'Giải trí',
  '25': 'Tin tức và chính trị',
  '26': 'Hướng dẫn và phong cách',
  '27': 'Giáo dục',
  '28': 'Khoa học và công nghệ',
} as const;
export type YoutubeCategory = keyof typeof YOUTUBE_CATEGORIES;

/** What YouTube accepts (its upload rules) and what MARIS checks before an upload. */
export const YOUTUBE_RULES = {
  titleMaxChars: 100,
  descriptionMaxBytes: 5000,
  tagsMaxChars: 500,
  /** Shorts: square or vertical, up to 3 minutes. */
  shortMaxSec: 180,
  /** Channels that are not verified upload up to 15 minutes. */
  unverifiedMaxSec: 15 * 60,
  thumbnailMaxMb: 2,
  videoMaxMb: 20_000,
} as const;

export const YOUTUBE_UPLOAD_STATUSES = [
  'scheduled',
  'uploading',
  'processing',
  'published',
  'failed',
  'cancelled',
] as const;
export type YoutubeUploadStatus = (typeof YOUTUBE_UPLOAD_STATUSES)[number];
export const YOUTUBE_UPLOAD_STATUS_LABEL: Record<YoutubeUploadStatus, string> = {
  scheduled: 'Chờ tải lên',
  uploading: 'Đang tải lên',
  processing: 'YouTube đang xử lý',
  published: 'Đã lên YouTube',
  failed: 'Lỗi, chờ xử lý',
  cancelled: 'Đã hủy',
};

export const scheduleYoutubeSchema = z.object({
  itemId: z.uuid(),
  channelIds: z.array(z.uuid()).min(1).max(GOOGLE_LIMITS.channels),
  format: z.enum(YOUTUBE_FORMATS).default('video'),
  title: z.string().trim().min(1).max(YOUTUBE_RULES.titleMaxChars),
  description: z.string().trim().max(YOUTUBE_RULES.descriptionMaxBytes).default(''),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  categoryId: z.enum(Object.keys(YOUTUBE_CATEGORIES) as [YoutubeCategory]).default('22'),
  privacy: z.enum(YOUTUBE_PRIVACY).default('public'),
  /** Required by YouTube (and children's privacy laws): whether the video is made for kids. */
  madeForKids: z.boolean(),
  /** The video has realistic altered or AI-made content (YouTube's disclosure). */
  syntheticMedia: z.boolean().default(false),
  /** An approved image item (JPEG or PNG, 2 MB at most) for the custom thumbnail. */
  thumbnailItemId: z.uuid().nullable().default(null),
  /** When YouTube makes the video public; null means at once. Only for public videos. */
  at: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type ScheduleYoutube = z.infer<typeof scheduleYoutubeSchema>;

export const listYoutubeUploadsSchema = z.object({
  status: z.enum(YOUTUBE_UPLOAD_STATUSES).optional(),
  itemId: z.uuid().optional(),
});
export type ListYoutubeUploads = z.infer<typeof listYoutubeUploadsSchema>;

export interface YoutubeUploadResponse {
  id: string;
  itemId: string;
  itemTitle: string;
  version: number;
  channelId: string;
  channelTitle: string;
  format: YoutubeFormat;
  title: string;
  privacy: YoutubePrivacy;
  /** When YouTube makes it public, when scheduled there. */
  publishAt: string | null;
  madeForKids: boolean;
  syntheticMedia: boolean;
  thumbnailItemId: string | null;
  status: YoutubeUploadStatus;
  attempts: number;
  /** Share of the file YouTube has, while uploading. */
  uploadedPct: number | null;
  videoId: string | null;
  url: string | null;
  /** What YouTube reports after processing. */
  youtubePrivacy: string | null;
  /** Things to know that did not stop the upload (thumbnail refused, kept private). */
  warnings: string[];
  errorCode: string | null;
  errorMessage: string | null;
  createdByName: string;
  createdAt: string;
  publishedAt: string | null;
}
