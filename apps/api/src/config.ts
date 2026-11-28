import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  MFA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  VAULT_MASTER_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  OUTBOX_RELAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  // Allow AI Provider base URLs on private networks (self-hosted gateways). Off by default (SSRF).
  AI_ALLOW_PRIVATE_URLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Allow connectors to call private networks (n8n on this machine or the office LAN). Off by default (SSRF).
  CONNECTOR_ALLOW_PRIVATE_URLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AI_RETRY_BASE_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  // Runs approved AI tasks from the maris-tasks queue in this process.
  AI_TASK_WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Uploaded files. Local disk for now; keep this folder in your backups.
  FILE_STORAGE_DIR: z.string().min(1).default('./data/uploads'),
  FILE_MAX_MB: z.coerce.number().int().min(1).max(500).default(25),
  // Files in the content library (videos are large). Streamed to disk, never held in memory.
  CONTENT_MAX_MB: z.coerce.number().int().min(1).max(20_000).default(2048),
  // Meta Graph API and the Facebook sign-in page. Changed only for tests.
  META_GRAPH_URL: z.string().url().default('https://graph.facebook.com'),
  META_DIALOG_URL: z.string().url().default('https://www.facebook.com'),
  META_GRAPH_VIDEO_URL: z.string().url().default('https://graph-video.facebook.com'),
  META_UPLOAD_URL: z.string().url().default('https://rupload.facebook.com'),
  // Publishes scheduled Meta posts from this process (spec Part 14).
  META_PUBLISHER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // The market's time zone: per-day post limits and publishing slots follow it.
  META_TIMEZONE: z.string().min(1).default('Asia/Ho_Chi_Minh'),
  META_RETRY_BASE_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  // The address Meta reaches this API at, for the webhook (public HTTPS in production).
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  // Reads new comments and messages every this many minutes while the webhook is quiet; 0 = off.
  META_INBOX_POLL_MIN: z.coerce.number().int().min(0).max(1440).default(15),
  // Reads new Lead Ads leads of each Page every this many minutes (slower while the webhook works); 0 = off.
  META_LEADS_POLL_MIN: z.coerce.number().int().min(0).max(1440).default(15),
  // Reads campaigns and daily ad figures of each ad account every this many minutes (in turn); 0 = off.
  META_ADS_POLL_MIN: z.coerce.number().int().min(0).max(1440).default(30),
  // Google sign-in, token and API hosts (spec Part 16). Changed only for tests.
  GOOGLE_ACCOUNTS_URL: z.string().url().default('https://accounts.google.com'),
  GOOGLE_OAUTH_URL: z.string().url().default('https://oauth2.googleapis.com'),
  GOOGLE_API_URL: z.string().url().default('https://www.googleapis.com'),
  GOOGLE_RETRY_BASE_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  // Uploads approved videos to YouTube from this process (spec Part 17).
  YOUTUBE_UPLOADER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // TikTok sign-in and API hosts (spec Part 17). Changed only for tests.
  TIKTOK_AUTH_URL: z.string().url().default('https://www.tiktok.com'),
  TIKTOK_API_URL: z.string().url().default('https://open.tiktokapis.com'),
  TIKTOK_RETRY_BASE_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  // Posts approved videos to TikTok from this process.
  TIKTOK_PUBLISHER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Shopify and POSCake (spec Part 18). The Shopify Admin API version MARIS speaks.
  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default('2026-10'),
  // Sends Shopify calls here instead of https://<store>.myshopify.com. Only for tests.
  SHOPIFY_ORIGIN: z.string().url().optional(),
  POSCAKE_API_URL: z.string().url().default('https://pos.pages.fm/api/v1'),
  COMMERCE_RETRY_BASE_MS: z.coerce.number().int().min(0).max(60_000).default(500),
  // Minutes between automatic reads of connected stores; 0 reads only on request.
  COMMERCE_SYNC_MIN: z.coerce.number().int().min(0).max(1440).default(15),
  NODE_ENV: z.string().default('development'),
});

export type AppConfig = z.infer<typeof envSchema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
