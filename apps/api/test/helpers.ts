import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { migrate } from '@maris/db';
import { createApp } from '../src/bootstrap-app';
import { loadConfig } from '../src/config';

export const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? 'postgres://maris:maris_dev@localhost:5432/maris';
export const APP_URL = process.env.DATABASE_URL ?? 'postgres://maris_app:maris_app_dev@localhost:5432/maris';

export async function resetDatabase(): Promise<void> {
  await migrate(ADMIN_URL);
  const sql = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await sql`TRUNCATE security.audit_logs, identity.tenant_members, identity.role_permissions,
            identity.roles, identity.sessions, identity.tenants, identity.users`;
  await sql.end();
}

export async function startApp(): Promise<INestApplication> {
  const config = loadConfig({
    DATABASE_URL: APP_URL,
    MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY ?? randomBytes(32).toString('base64'),
  });
  const app = await createApp(config);
  await app.init();
  return app;
}

export function admin(): postgres.Sql {
  return postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
}
