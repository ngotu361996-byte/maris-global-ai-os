-- MARIS Core Platform: identity + security schemas.
-- Tenant isolation: every tenant-scoped table has tenant_id NOT NULL and RLS.
-- The API sets app.tenant_id / app.user_id with SET LOCAL (set_config(..., true))
-- inside each transaction, after verifying membership server-side.

CREATE SCHEMA IF NOT EXISTS maris_ctx;
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS security;

CREATE OR REPLACE FUNCTION maris_ctx.tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION maris_ctx.user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ---------- identity ----------
CREATE TABLE identity.tenants (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1
);

CREATE TABLE identity.users (
  id                  uuid PRIMARY KEY,
  email               text NOT NULL,
  display_name        text NOT NULL,
  password_hash       text NOT NULL,
  mfa_enabled         boolean NOT NULL DEFAULT false,
  mfa_totp_secret_enc text,
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  version             integer NOT NULL DEFAULT 1,
  CONSTRAINT users_email_lower CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_key ON identity.users (email) WHERE deleted_at IS NULL;

CREATE TABLE identity.sessions (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES identity.users(id),
  token_hash  bytea NOT NULL UNIQUE,
  ip          text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX sessions_user_idx ON identity.sessions (user_id);

CREATE TABLE identity.permissions (
  key          text PRIMARY KEY,
  description  text NOT NULL
);

CREATE TABLE identity.roles (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  key         text NOT NULL,
  name        text NOT NULL,
  builtin     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, key)
);

CREATE TABLE identity.role_permissions (
  tenant_id       uuid NOT NULL REFERENCES identity.tenants(id),
  role_id         uuid NOT NULL REFERENCES identity.roles(id) ON DELETE CASCADE,
  permission_key  text NOT NULL REFERENCES identity.permissions(key),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE identity.tenant_members (
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  user_id     uuid NOT NULL REFERENCES identity.users(id),
  role_id     uuid NOT NULL REFERENCES identity.roles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX tenant_members_user_idx ON identity.tenant_members (user_id);

INSERT INTO identity.permissions (key, description) VALUES
  ('tenant.read',     'Xem thông tin Tenant'),
  ('tenant.update',   'Sửa thông tin Tenant'),
  ('members.read',    'Xem thành viên'),
  ('members.manage',  'Thêm, đổi vai trò, gỡ thành viên'),
  ('roles.read',      'Xem vai trò và quyền'),
  ('roles.manage',    'Sửa quyền của vai trò'),
  ('audit.read',      'Xem và kiểm tra nhật ký audit');

-- ---------- security ----------
CREATE TABLE security.audit_logs (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  seq            bigint NOT NULL,
  actor_user_id  uuid,
  action         text NOT NULL,
  target_type    text,
  target_id      text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip             text,
  created_at     timestamptz NOT NULL,
  prev_hash      text NOT NULL,
  hash           text NOT NULL,
  UNIQUE (tenant_id, seq)
);

-- Append-only, even for the table owner.
CREATE OR REPLACE FUNCTION security.audit_logs_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON security.audit_logs
  FOR EACH ROW EXECUTE FUNCTION security.audit_logs_immutable();

-- ---------- Row-Level Security ----------
ALTER TABLE identity.tenants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.tenants         FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.roles           FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.tenant_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.tenant_members  FORCE ROW LEVEL SECURITY;
ALTER TABLE security.audit_logs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.audit_logs      FORCE ROW LEVEL SECURITY;

-- A user may always see their own memberships (to list their tenants);
-- everything else is limited to the current tenant.
CREATE POLICY tenant_members_access ON identity.tenant_members
  USING (tenant_id = maris_ctx.tenant_id() OR user_id = maris_ctx.user_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

CREATE POLICY tenants_access ON identity.tenants
  USING (
    id = maris_ctx.tenant_id()
    OR EXISTS (SELECT 1 FROM identity.tenant_members m
               WHERE m.tenant_id = tenants.id AND m.user_id = maris_ctx.user_id())
  )
  WITH CHECK (id = maris_ctx.tenant_id());

CREATE POLICY roles_access ON identity.roles
  USING (
    tenant_id = maris_ctx.tenant_id()
    OR EXISTS (SELECT 1 FROM identity.tenant_members m
               WHERE m.role_id = roles.id AND m.user_id = maris_ctx.user_id())
  )
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

CREATE POLICY role_permissions_access ON identity.role_permissions
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

CREATE POLICY audit_logs_access ON security.audit_logs
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- ---------- grants for the runtime role ----------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maris_app') THEN
    GRANT USAGE ON SCHEMA maris_ctx, identity, security TO maris_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA maris_ctx TO maris_app;
    GRANT SELECT, INSERT, UPDATE ON identity.tenants, identity.users, identity.sessions,
      identity.roles, identity.tenant_members TO maris_app;
    GRANT SELECT, INSERT, DELETE ON identity.role_permissions TO maris_app;
    GRANT DELETE ON identity.tenant_members TO maris_app;
    GRANT SELECT ON identity.permissions TO maris_app;
    GRANT SELECT, INSERT ON security.audit_logs TO maris_app;
  ELSE
    RAISE EXCEPTION 'Role maris_app must exist before migrating (see infra/postgres-init.sql)';
  END IF;
END $$;
