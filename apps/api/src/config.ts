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
  META_RETRY_BASE_MS: z.coerce.number().int().min(0).max(60_000).default(500),
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
