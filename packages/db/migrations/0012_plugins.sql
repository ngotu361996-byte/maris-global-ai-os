-- Sprint 12 (Phase 4): Plugin Center and Extension SDK (spec Part 23). A plugin is a signed package
-- of declarative parts (skills, connectors, workflows) with one manifest: id, version, author,
-- permissions, dependencies, compatibility, resource budget, timeout, signature and tests. No code
-- from a plugin runs in MARIS; its parts are installed through the same checks as their own imports.
-- Installing leaves every part off. Someone with ai.approve activates the plugin after its checksum,
-- signature, dependencies and tests pass. A revoked plugin stays off for good until it is removed.

CREATE SCHEMA IF NOT EXISTS ext;

CREATE TABLE ext.plugins (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES identity.tenants(id),
  key               text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  version           text NOT NULL CHECK (length(version) <= 40),
  description       text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  author            text NOT NULL CHECK (length(author) BETWEEN 1 AND 120),
  status            text NOT NULL DEFAULT 'installed'
                    CHECK (status IN ('installed', 'active', 'paused', 'revoked')),
  -- The whole manifest as installed (validated by the API, contracts `plugins.ts`).
  manifest          jsonb NOT NULL,
  checksum          text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  -- trusted: signed by a publisher key this workspace trusts; untrusted: signed by an unknown key.
  signature_status  text NOT NULL CHECK (signature_status IN ('trusted', 'untrusted', 'unsigned')),
  signer_key_id     text CHECK (length(signer_key_id) <= 80),
  installed_by      uuid NOT NULL REFERENCES identity.users(id),
  activated_by      uuid REFERENCES identity.users(id),
  activated_at      timestamptz,
  revoked_reason    text CHECK (length(revoked_reason) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CHECK (status <> 'active' OR activated_by IS NOT NULL)
);
CREATE UNIQUE INDEX plugins_tenant_key ON ext.plugins (tenant_id, key) WHERE deleted_at IS NULL;

-- Every version installed, so an update can be rolled back to an earlier file.
CREATE TABLE ext.plugin_versions (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES identity.tenants(id),
  plugin_id         uuid NOT NULL REFERENCES ext.plugins(id),
  version           text NOT NULL CHECK (length(version) <= 40),
  manifest          jsonb NOT NULL,
  checksum          text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  signature_status  text NOT NULL CHECK (signature_status IN ('trusted', 'untrusted', 'unsigned')),
  installed_by      uuid NOT NULL REFERENCES identity.users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plugin_versions_plugin ON ext.plugin_versions (tenant_id, plugin_id, created_at DESC);

-- Which skills, connectors and workflows a plugin installed.
CREATE TABLE ext.plugin_components (
  tenant_id     uuid NOT NULL REFERENCES identity.tenants(id),
  plugin_id     uuid NOT NULL REFERENCES ext.plugins(id),
  kind          text NOT NULL CHECK (kind IN ('skill', 'connector', 'workflow')),
  key           text NOT NULL CHECK (length(key) <= 64),
  component_id  uuid NOT NULL,
  PRIMARY KEY (plugin_id, kind, key)
);
CREATE INDEX plugin_components_lookup ON ext.plugin_components (tenant_id, kind, key);

-- Publisher keys this workspace trusts (Ed25519 public keys, PEM).
CREATE TABLE ext.trusted_publishers (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  key_id      text NOT NULL CHECK (key_id ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  public_key  text NOT NULL CHECK (length(public_key) <= 1000),
  added_by    uuid NOT NULL REFERENCES identity.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX trusted_publishers_key ON ext.trusted_publishers (tenant_id, key_id) WHERE revoked_at IS NULL;

ALTER TABLE ext.plugins ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.plugins FORCE ROW LEVEL SECURITY;
CREATE POLICY plugins_access ON ext.plugins
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ext.plugin_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.plugin_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_versions_access ON ext.plugin_versions
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ext.plugin_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.plugin_components FORCE ROW LEVEL SECURITY;
CREATE POLICY plugin_components_access ON ext.plugin_components
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ext.trusted_publishers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ext.trusted_publishers FORCE ROW LEVEL SECURITY;
CREATE POLICY trusted_publishers_access ON ext.trusted_publishers
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT USAGE ON SCHEMA ext TO maris_app;
GRANT SELECT, INSERT, UPDATE ON ext.plugins TO maris_app;
GRANT SELECT, INSERT ON ext.plugin_versions TO maris_app;
GRANT SELECT, INSERT, DELETE ON ext.plugin_components TO maris_app;
GRANT SELECT, INSERT, UPDATE ON ext.trusted_publishers TO maris_app;
