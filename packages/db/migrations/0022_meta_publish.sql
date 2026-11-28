-- Sprint 22 (Phase 7): publishing approved content to Facebook Pages and Instagram (spec Part 14).
-- A post is one version of an approved item going to one Page or Instagram account at a time.
-- The same version goes to the same account in the same format once (idempotency): retrying a
-- failed post reuses its row. MARIS keeps the schedule itself; a publisher in the API claims due
-- posts (app.system = 'meta_publisher') and runs each one as the person who scheduled it.
-- A post that fails for good, or whose result is unknown, waits in the failed list (the dead
-- letter queue) until someone retries or cancels it.

INSERT INTO identity.permissions (key, description) VALUES
  ('meta.publish', 'Lên lịch, hủy và đăng lại bài lên Facebook và Instagram');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'meta.publish'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager')
ON CONFLICT DO NOTHING;

CREATE TABLE meta.posts (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES identity.tenants(id),
  item_id          uuid NOT NULL REFERENCES content.items(id),
  version          integer NOT NULL CHECK (version >= 1),
  asset_id         uuid NOT NULL REFERENCES meta.assets(id),
  format           text NOT NULL CHECK (format IN ('feed', 'photo', 'video', 'reel', 'ig_image', 'ig_reel')),
  caption          text CHECK (length(caption) <= 63206),
  link             text CHECK (length(link) <= 2000),
  scheduled_at     timestamptz NOT NULL,
  -- The day in the market's time zone, for the per-day limits.
  local_day        date NOT NULL,
  status           text NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'publishing', 'processing', 'published', 'failed', 'cancelled')),
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL,
  locked_until     timestamptz,
  -- What has been done at Meta so far (upload and container ids), so a step is not repeated.
  stage            jsonb NOT NULL DEFAULT '{}',
  external_id      text CHECK (length(external_id) <= 100),
  permalink        text CHECK (length(permalink) <= 2000),
  error_code       text CHECK (length(error_code) <= 60),
  error_message    text CHECK (length(error_message) <= 1000),
  created_by       uuid NOT NULL REFERENCES identity.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  CHECK (status <> 'published' OR external_id IS NOT NULL)
);
CREATE UNIQUE INDEX posts_once ON meta.posts (tenant_id, item_id, version, asset_id, format)
  WHERE status <> 'cancelled';
CREATE INDEX posts_due ON meta.posts (next_attempt_at) WHERE status IN ('scheduled', 'processing');
CREATE INDEX posts_day ON meta.posts (tenant_id, local_day, asset_id);
CREATE INDEX posts_tenant_time ON meta.posts (tenant_id, scheduled_at DESC);

ALTER TABLE meta.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.posts FORCE ROW LEVEL SECURITY;
CREATE POLICY posts_access ON meta.posts
  USING (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'meta_publisher')
  WITH CHECK (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'meta_publisher');

GRANT SELECT, INSERT, UPDATE ON meta.posts TO maris_app;
