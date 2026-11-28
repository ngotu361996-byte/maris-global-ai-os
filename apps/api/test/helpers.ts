import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { migrate } from '@maris/db';
import { createApp } from '../src/bootstrap-app';
import { loadConfig } from '../src/config';

export const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://maris:maris_dev@localhost:5432/maris';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
export const APP_URL =
  process.env.DATABASE_URL ?? 'postgres://maris_app:maris_app_dev@localhost:5432/maris';

export async function resetDatabase(): Promise<void> {
  await migrate(ADMIN_URL);
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await sql`TRUNCATE commerce.changes, commerce.stock, commerce.orders, commerce.variants, commerce.products, commerce.locations, commerce.stores, tiktok.posts, tiktok.videos, tiktok.accounts, tiktok.apps, google.youtube_uploads, google.channels, google.connections, google.apps, meta.ad_changes, meta.ad_insights, meta.ad_objects, crm.activities, meta.leads, meta.lead_forms, meta.webhook_events, meta.messages, meta.threads, crm.contacts, meta.posts, integration.api_calls, meta.assets, meta.connections, meta.apps, content.media_outputs, content.generations, content.item_versions, content.items, content.assets, content.folders, infra.worker_job_logs, infra.worker_jobs, infra.device_events, infra.device_metrics, infra.devices, ext.plugin_components, ext.plugin_versions, ext.plugins, ext.trusted_publishers, integration.webhook_events, integration.connector_calls, integration.connectors, work.workflow_run_steps, ai.files, ai.plans, ai.council_turns, ai.provider_calls, ai.councils, ai.models, ai.tasks, work.workflow_runs, work.workflow_versions, work.workflow_definitions, ai.skills, ai.budgets, ai.controls, ai.messages, ai.conversations, ai.memories, ai.projects, ai.agent_versions, ai.agents, ai.providers, work.outbox_events, security.secrets, identity.invitations, security.audit_logs,
            identity.tenant_members, identity.role_permissions, identity.roles, identity.sessions,
            identity.tenants, identity.users`;
  await sql.end();
  const redis = new Redis(REDIS_URL);
  const keys = [
    ...(await redis.keys('rl:*')),
    ...(await redis.keys('ai:cb:*')),
    ...(await redis.keys('meta:*')),
    ...(await redis.keys('google:*')),
    ...(await redis.keys('tiktok:*')),
    ...(await redis.keys('commerce:*')),
  ];
  if (keys.length) await redis.del(...keys);
  await redis.quit();
}

export async function startApp(env: Record<string, string> = {}): Promise<INestApplication> {
  const config = loadConfig({
    DATABASE_URL: APP_URL,
    MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY ?? randomBytes(32).toString('base64'),
    VAULT_MASTER_KEY: process.env.VAULT_MASTER_KEY ?? randomBytes(32).toString('base64'),
    REDIS_URL,
    // Tests drive the relay by hand with relayOnce().
    OUTBOX_RELAY_ENABLED: 'false',
    // Tests read ad accounts by hand with syncTenant().
    META_ADS_POLL_MIN: '0',
    ...env,
  });
  const app = await createApp(config);
  await app.init();
  return app;
}

export function admin(): postgres.Sql {
  return postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
}
