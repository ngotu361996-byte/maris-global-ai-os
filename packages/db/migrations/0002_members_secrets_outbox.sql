-- Sprint 2: invitations, Secret Vault, outbox events.

-- ---------- permissions ----------
INSERT INTO identity.permissions (key, description) VALUES
  ('secrets.read',   'Xem danh sách secret (không xem giá trị)'),
  ('secrets.manage', 'Thêm, xóa secret trong Secret Vault');

-- Built-in owner/administrator roles get the new permissions.
INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('secrets.read'), ('secrets.manage')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

-- ---------- invitations ----------
CREATE TABLE identity.invitations (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  email        text NOT NULL CHECK (email = lower(email)),
  role_id      uuid NOT NULL REFERENCES identity.roles(id),
  token_hash   bytea NOT NULL UNIQUE,
  invited_by   uuid NOT NULL REFERENCES identity.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES identity.users(id),
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX invitations_open_email ON identity.invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE identity.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_access ON identity.invitations
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- The invitee has no tenant context yet. This lookup by token hash is the only
-- way around RLS for invitations, and returns just what accepting needs.
CREATE OR REPLACE FUNCTION identity.invitation_by_token(p_token_hash bytea)
  RETURNS TABLE (id uuid, tenant_id uuid, email text, role_id uuid,
                 expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, identity AS $$
    SELECT i.id, i.tenant_id, i.email, i.role_id, i.expires_at, i.accepted_at, i.revoked_at
    FROM identity.invitations i WHERE i.token_hash = p_token_hash
$$;
REVOKE ALL ON FUNCTION identity.invitation_by_token(bytea) FROM PUBLIC;

-- ---------- Secret Vault ----------
CREATE TABLE security.secrets (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  name         text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_.-]{0,99}$'),
  ciphertext   text NOT NULL,
  key_version  integer NOT NULL DEFAULT 1,
  created_by   uuid NOT NULL REFERENCES identity.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX secrets_name_live ON security.secrets (tenant_id, name) WHERE deleted_at IS NULL;

ALTER TABLE security.secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY secrets_access ON security.secrets
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- ---------- outbox ----------
CREATE SCHEMA IF NOT EXISTS work;
CREATE TABLE work.outbox_events (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES identity.tenants(id),
  type          text NOT NULL CHECK (type ~ '^[a-z_]+\.[a-z_]+\.[a-z_]+$'),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished ON work.outbox_events (created_at) WHERE published_at IS NULL;

ALTER TABLE work.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.outbox_events FORCE ROW LEVEL SECURITY;
-- Writers see only their tenant. The relay (app.system = 'outbox_relay') reads all
-- tenants but only to publish; it never returns rows to a user request.
CREATE POLICY outbox_access ON work.outbox_events
  USING (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'outbox_relay')
  WITH CHECK (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'outbox_relay');

-- ---------- grants ----------
GRANT USAGE ON SCHEMA work TO maris_app;
GRANT SELECT, INSERT, UPDATE ON identity.invitations TO maris_app;
GRANT EXECUTE ON FUNCTION identity.invitation_by_token(bytea) TO maris_app;
GRANT SELECT, INSERT, UPDATE ON security.secrets TO maris_app;
GRANT SELECT, INSERT, UPDATE ON work.outbox_events TO maris_app;
