-- Sprint 17 (Phase 6): AI content writing (spec Part 13, M13).
-- A generation asks an AI to write the next version of a finished item from verified product facts
-- and reference sources. It runs as an AI task (already approved by the person who asked, within a
-- small budget), and its text is saved as a new version that still needs human approval.
-- Numbers and claims the facts do not support are recorded as warnings and block approval.

INSERT INTO identity.permissions (key, description) VALUES
  ('content.generate', 'Dùng AI viết nội dung và tạo phiên bản ngôn ngữ, nền tảng khác');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'content.generate'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager')
ON CONFLICT DO NOTHING;

-- An item made from another one in a different language, market or platform.
ALTER TABLE content.items ADD COLUMN variant_of uuid REFERENCES content.items(id);

-- The item an AI task writes for; its prompt is the content brief as built by MARIS.
ALTER TABLE ai.tasks ADD COLUMN content_item_id uuid REFERENCES content.items(id);

CREATE TABLE content.generations (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES identity.tenants(id),
  item_id            uuid NOT NULL REFERENCES content.items(id),
  task_id            uuid NOT NULL UNIQUE REFERENCES ai.tasks(id),
  mode               text NOT NULL CHECK (mode IN ('write', 'variant')),
  from_item_id       uuid REFERENCES content.items(id),
  from_version       integer CHECK (from_version >= 1),
  product_asset_ids  uuid[] NOT NULL DEFAULT '{}',
  source_asset_ids   uuid[] NOT NULL DEFAULT '{}',
  brief              text CHECK (length(brief) <= 4000),
  tone               text CHECK (length(tone) <= 100),
  -- The text the result is checked against: the facts, the brief and the item's own words.
  allowed_text       text NOT NULL DEFAULT '' CHECK (length(allowed_text) <= 400000),
  status             text NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
  version            integer CHECK (version >= 1),
  warnings           text[] NOT NULL DEFAULT '{}',
  error_code         text,
  error_message      text CHECK (length(error_message) <= 1000),
  created_by         uuid NOT NULL REFERENCES identity.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  CHECK ((mode = 'variant') = (from_item_id IS NOT NULL))
);
CREATE INDEX generations_item ON content.generations (item_id, created_at DESC);
-- One generation at a time per item, so two results cannot race for the same version number.
CREATE UNIQUE INDEX generations_one_running ON content.generations (item_id) WHERE status = 'running';

ALTER TABLE content.generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.generations FORCE ROW LEVEL SECURITY;
CREATE POLICY generations_access ON content.generations
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT SELECT, INSERT, UPDATE ON content.generations TO maris_app;
