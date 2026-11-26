import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors migrations/*.sql. The SQL files are the source of truth for DDL and RLS.
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const identity = pgSchema('identity');
export const security = pgSchema('security');

export const tenants = identity.table('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  deletedAt: ts('deleted_at'),
  version: integer('version').notNull().default(1),
});

export const users = identity.table('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  mfaTotpSecretEnc: text('mfa_totp_secret_enc'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: ts('locked_until'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
  version: integer('version').notNull().default(1),
});

export const sessions = identity.table('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
});

export const permissions = identity.table('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
});

export const roles = identity.table('roles', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  builtin: boolean('builtin').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  version: integer('version').notNull().default(1),
});

export const rolePermissions = identity.table(
  'role_permissions',
  {
    tenantId: uuid('tenant_id').notNull(),
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const tenantMembers = identity.table(
  'tenant_members',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const auditLogs = security.table('audit_logs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ip: text('ip'),
  createdAt: ts('created_at').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});
