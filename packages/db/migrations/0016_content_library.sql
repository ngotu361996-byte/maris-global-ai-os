-- Sprint 16 (Phase 6): content libraries (spec Part 11).
-- Source library (M09): original files, product facts and references, with source and usage rights.
-- Output library (M10): finished content as numbered versions that are never overwritten; each
-- version records its source assets, the Skill / Workflow / AI task that made it, and who made it.
-- File bytes live in file storage under keys MARIS builds; rows keep a SHA-256 for duplicate checks.

INSERT INTO identity.permissions (key, description) VALUES
  ('content.read', 'Xem kho nội dung gốc và thành phẩm'),
  ('content.manage', 'Thêm, sửa, lưu trữ nội dung và tạo phiên bản'),
  ('content.approve', 'Duyệt, từ chối, xuất bản thành phẩm và xác minh thông tin sản phẩm');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('content.read'), ('content.manage'), ('content.approve')) AS p(key)
WHERE r.builtin AND (
  r.key IN ('owner', 'administrator')
  OR (r.key = 'manager' AND p.key IN ('content.read', 'content.manage'))
  OR (r.key = 'member' AND p.key = 'content.read')
)
ON CONFLICT DO NOTHING;

CREATE SCHEMA IF NOT EXISTS content;

CREATE TABLE content.folders (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  library     text NOT NULL CHECK (library IN ('source', 'output')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  parent_id   uuid REFERENCES content.folders(id),
  created_by  uuid NOT NULL REFERENCES identity.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX folders_name ON content.folders
  (tenant_id, library, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  WHERE deleted_at IS NULL;

CREATE TABLE content.assets (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES identity.tenants(id),
  folder_id          uuid REFERENCES content.folders(id),
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind               text NOT NULL
                     CHECK (kind IN ('video', 'image', 'audio', 'document', 'text', 'product', 'reference')),
  description        text CHECK (length(description) <= 5000),
  body               text CHECK (length(body) <= 200000),
  product            jsonb,
  file_name          text CHECK (length(file_name) BETWEEN 1 AND 255),
  mime               text,
  size_bytes         bigint CHECK (size_bytes > 0),
  storage_key        text,
  -- SHA-256 of the file, or of the text or product facts: the duplicate check.
  content_sha256     text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  source             text NOT NULL CHECK (source IN ('upload', 'manual', 'connector', 'url')),
  source_ref         text CHECK (length(source_ref) <= 1000),
  rights_status      text NOT NULL DEFAULT 'unknown'
                     CHECK (rights_status IN ('owned', 'licensed', 'permission', 'unknown', 'restricted')),
  rights_holder      text CHECK (length(rights_holder) <= 200),
  rights_note        text CHECK (length(rights_note) <= 2000),
  rights_expires_at  timestamptz,
  verified_by        uuid REFERENCES identity.users(id),
  verified_at        timestamptz,
  tags               text[] NOT NULL DEFAULT '{}',
  created_by         uuid NOT NULL REFERENCES identity.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  CHECK ((storage_key IS NULL) = (mime IS NULL) AND (storage_key IS NULL) = (size_bytes IS NULL)
         AND (storage_key IS NULL) = (file_name IS NULL)),
  CHECK (storage_key IS NOT NULL OR body IS NOT NULL OR product IS NOT NULL)
);
CREATE INDEX assets_recent ON content.assets (tenant_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX assets_hash ON content.assets (tenant_id, content_sha256) WHERE archived_at IS NULL;
CREATE INDEX assets_tags ON content.assets USING gin (tags);

-- The original is never overwritten: the file, text and product facts of an asset are fixed.
CREATE FUNCTION content.assets_keep_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.product IS DISTINCT FROM OLD.product
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'content.assets: the original of an asset cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assets_keep_original BEFORE UPDATE ON content.assets
  FOR EACH ROW EXECUTE FUNCTION content.assets_keep_original();

CREATE TABLE content.items (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES identity.tenants(id),
  folder_id         uuid REFERENCES content.folders(id),
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind              text NOT NULL CHECK (kind IN ('video', 'image', 'text', 'ad', 'audio', 'other')),
  language          text NOT NULL CHECK (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  market            text CHECK (length(market) <= 50),
  platform          text CHECK (platform IN ('facebook', 'instagram', 'tiktok', 'youtube', 'google',
                                             'website', 'shopify', 'email', 'other')),
  status            text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'in_review', 'approved', 'rejected', 'published', 'archived')),
  current_version   integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  tags              text[] NOT NULL DEFAULT '{}',
  review_note       text CHECK (length(review_note) <= 1000),
  submitted_by      uuid REFERENCES identity.users(id),
  submitted_at      timestamptz,
  reviewed_by       uuid REFERENCES identity.users(id),
  reviewed_at       timestamptz,
  published_url     text CHECK (length(published_url) <= 1000),
  published_at      timestamptz,
  created_by        uuid NOT NULL REFERENCES identity.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_recent ON content.items (tenant_id, updated_at DESC);
CREATE INDEX items_tags ON content.items USING gin (tags);

CREATE TABLE content.item_versions (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES identity.tenants(id),
  item_id           uuid NOT NULL REFERENCES content.items(id),
  version           integer NOT NULL CHECK (version >= 1),
  body              text CHECK (length(body) <= 200000),
  file_name         text CHECK (length(file_name) BETWEEN 1 AND 255),
  mime              text,
  size_bytes        bigint CHECK (size_bytes > 0),
  sha256            text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key       text,
  source_asset_ids  uuid[] NOT NULL DEFAULT '{}',
  skill_id          uuid REFERENCES ai.skills(id),
  skill_version     text,
  workflow_run_id   uuid REFERENCES work.workflow_runs(id),
  ai_task_id        uuid REFERENCES ai.tasks(id),
  note              text CHECK (length(note) <= 1000),
  created_by        uuid NOT NULL REFERENCES identity.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, version),
  CHECK (body IS NOT NULL OR storage_key IS NOT NULL)
);
CREATE INDEX item_versions_sources ON content.item_versions USING gin (source_asset_ids);

ALTER TABLE content.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.folders FORCE ROW LEVEL SECURITY;
CREATE POLICY folders_access ON content.folders
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE content.assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.assets FORCE ROW LEVEL SECURITY;
CREATE POLICY assets_access ON content.assets
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE content.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.items FORCE ROW LEVEL SECURITY;
CREATE POLICY items_access ON content.items
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE content.item_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.item_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY item_versions_access ON content.item_versions
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT USAGE ON SCHEMA content TO maris_app;
GRANT SELECT, INSERT, UPDATE ON content.folders, content.assets, content.items TO maris_app;
-- Versions are written once and never changed.
GRANT SELECT, INSERT ON content.item_versions TO maris_app;
