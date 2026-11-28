-- Sprint 21 (Phase 7): Meta Control Center connection and the API Governor (spec Parts 14 and 15).
-- A tenant signs in one Facebook account through the official OAuth flow of the Meta App it
-- registers (App ID here, App Secret in the Secret Vault). Its Pages, Instagram accounts and ad
-- accounts are synced as assets; at most 20 Pages and 10 ad accounts are turned on. Tokens are
-- sealed with the vault key and never leave the server.
-- Every Graph API call goes through the Governor, which records it here and keeps the internal
-- daily budget per API group (3,000 calls a day by default) and stops when Meta says to.

INSERT INTO identity.permissions (key, description) VALUES
  ('meta.read', 'Xem Trung tâm Meta: tài sản đã kết nối, quyền, hạn mức API'),
  ('meta.manage', 'Cài Meta App, kết nối và ngắt tài khoản Facebook, bật tắt tài sản');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('meta.read'), ('meta.manage')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'meta.read'
FROM identity.roles r
WHERE r.builtin AND r.key = 'manager'
ON CONFLICT DO NOTHING;

CREATE SCHEMA IF NOT EXISTS meta;

-- The Meta App a tenant signs in with. The App Secret stays in the Secret Vault, named here.
CREATE TABLE meta.apps (
  tenant_id        uuid PRIMARY KEY REFERENCES identity.tenants(id),
  app_id           text NOT NULL CHECK (app_id ~ '^[0-9]{5,20}$'),
  app_secret_name  text NOT NULL CHECK (length(app_secret_name) BETWEEN 1 AND 100),
  graph_version    text NOT NULL CHECK (graph_version ~ '^v[0-9]{2}\.0$'),
  -- Daily budget per API group, overriding the defaults of spec Part 15. {group: calls}.
  budgets          jsonb NOT NULL DEFAULT '{}',
  updated_by       uuid NOT NULL REFERENCES identity.users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The Facebook account a tenant signed in with: one at a time.
CREATE TABLE meta.connections (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES identity.tenants(id),
  fb_user_id        text NOT NULL CHECK (fb_user_id ~ '^[0-9]{1,30}$'),
  fb_name           text NOT NULL CHECK (length(fb_name) <= 200),
  -- Long-lived user token, sealed with the vault key (AES-256-GCM, bound to tenant and row).
  token_sealed      text,
  token_expires_at  timestamptz,
  scopes            text[] NOT NULL DEFAULT '{}',
  declined          text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'expired', 'invalid', 'removed')),
  check_error       text CHECK (length(check_error) <= 500),
  connected_by      uuid NOT NULL REFERENCES identity.users(id),
  connected_at      timestamptz NOT NULL DEFAULT now(),
  checked_at        timestamptz,
  synced_at         timestamptz,
  removed_at        timestamptz,
  CHECK (status <> 'removed' OR token_sealed IS NULL)
);
CREATE UNIQUE INDEX connections_one_per_tenant ON meta.connections (tenant_id) WHERE status <> 'removed';

-- Pages, Instagram accounts and ad accounts the signed-in account can use.
CREATE TABLE meta.assets (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES identity.tenants(id),
  connection_id   uuid NOT NULL REFERENCES meta.connections(id),
  kind            text NOT NULL CHECK (kind IN ('page', 'instagram', 'ad_account')),
  external_id     text NOT NULL CHECK (external_id ~ '^(act_)?[0-9]{1,30}$'),
  name            text NOT NULL CHECK (length(name) <= 300),
  username        text CHECK (length(username) <= 100),
  category        text CHECK (length(category) <= 200),
  -- The Page an Instagram account is linked to.
  page_id         uuid REFERENCES meta.assets(id),
  currency        text CHECK (currency ~ '^[A-Z]{3}$'),
  timezone        text CHECK (length(timezone) <= 100),
  account_status  integer,
  tasks           text[] NOT NULL DEFAULT '{}',
  -- Page token, sealed like the user token. Null for other kinds and for removed assets.
  token_sealed    text,
  enabled         boolean NOT NULL DEFAULT false,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  CHECK (kind = 'page' OR token_sealed IS NULL),
  CHECK (removed_at IS NULL OR (NOT enabled AND token_sealed IS NULL))
);
CREATE UNIQUE INDEX assets_tenant_external ON meta.assets (tenant_id, kind, external_id);

-- One row per call the Governor made or refused (cached answers are not calls).
CREATE TABLE integration.api_calls (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES identity.tenants(id),
  provider      text NOT NULL CHECK (provider IN ('meta')),
  api_group     text NOT NULL CHECK (api_group ~ '^[a-z_]{1,30}$'),
  method        text NOT NULL CHECK (method IN ('GET', 'POST', 'DELETE')),
  -- Path only: no query string, so no token or secret.
  path          text NOT NULL CHECK (length(path) <= 300),
  asset_id      uuid REFERENCES meta.assets(id),
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'failed', 'refused')),
  http_status   integer,
  error_code    text CHECK (length(error_code) <= 60),
  error_message text CHECK (length(error_message) <= 500),
  duration_ms   integer CHECK (duration_ms >= 0),
  -- Rate limit headers Meta sent back (X-App-Usage and the like), parsed.
  usage         jsonb,
  called_by     uuid REFERENCES identity.users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_calls_tenant_time ON integration.api_calls (tenant_id, provider, created_at DESC);

ALTER TABLE meta.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.apps FORCE ROW LEVEL SECURITY;
CREATE POLICY apps_access ON meta.apps
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE meta.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.connections FORCE ROW LEVEL SECURITY;
CREATE POLICY connections_access ON meta.connections
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE meta.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.assets FORCE ROW LEVEL SECURITY;
CREATE POLICY assets_access ON meta.assets
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE integration.api_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.api_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY api_calls_access ON integration.api_calls
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT USAGE ON SCHEMA meta TO maris_app;
GRANT SELECT, INSERT, UPDATE ON meta.apps TO maris_app;
GRANT SELECT, INSERT, UPDATE ON meta.connections TO maris_app;
GRANT SELECT, INSERT, UPDATE ON meta.assets TO maris_app;
GRANT SELECT, INSERT ON integration.api_calls TO maris_app;
