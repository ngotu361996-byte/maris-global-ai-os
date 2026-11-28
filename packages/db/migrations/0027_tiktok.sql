-- Sprint 27 (Phase 8): TikTok Center (spec Part 17, M19).
-- A tenant registers its own TikTok app (client key here, client secret in the Secret Vault) and
-- signs in TikTok accounts through TikTok's own Login Kit page, asking for each service on its own.
-- A feature is ready only for the scopes TikTok granted. Refresh tokens (365 days) are sealed with
-- the vault key and never leave the server; access tokens (24 hours) live in memory only.
-- Approved video items are posted with TikTok's Content Posting API: straight to the profile
-- (Direct Post) or to the creator's TikTok inbox as a draft to finish in the app. TikTok has no
-- scheduled posting, so MARIS itself waits until the chosen time. Before each Direct Post MARIS
-- asks TikTok what the creator may post (privacy options, longest video, interactions turned off).
-- Each account's own videos and figures are read with the Display API for the content report.

INSERT INTO identity.permissions (key, description) VALUES
  ('tiktok.read', 'Xem Trung tâm TikTok: tài khoản, bài đăng, số liệu video'),
  ('tiktok.manage', 'Cài ứng dụng TikTok, kết nối và ngắt tài khoản TikTok, bật tắt tài khoản'),
  ('tiktok.publish', 'Đăng video lên TikTok hoặc gửi vào hộp nháp, hủy và đăng lại');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('tiktok.read'), ('tiktok.publish')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager')
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'tiktok.manage'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

CREATE SCHEMA IF NOT EXISTS tiktok;

-- The TikTok for Developers app a tenant signs in with.
CREATE TABLE tiktok.apps (
  tenant_id           uuid PRIMARY KEY REFERENCES identity.tenants(id),
  client_key          text NOT NULL CHECK (client_key ~ '^[A-Za-z0-9]{8,64}$'),
  client_secret_name  text NOT NULL CHECK (length(client_secret_name) BETWEEN 1 AND 100),
  -- TikTok has audited the app for Direct Post. Until then TikTok only lets it post as private.
  audited             boolean NOT NULL DEFAULT false,
  updated_by          uuid NOT NULL REFERENCES identity.users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- TikTok accounts signed in.
CREATE TABLE tiktok.accounts (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES identity.tenants(id),
  -- TikTok's id of the account for this app.
  open_id               text NOT NULL CHECK (open_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  display_name          text NOT NULL CHECK (length(display_name) <= 200),
  username              text CHECK (length(username) <= 100),
  avatar_url            text CHECK (length(avatar_url) <= 2000),
  -- Refresh token, sealed with the vault key (AES-256-GCM, bound to tenant and row).
  refresh_token_sealed  text,
  refresh_expires_at    timestamptz,
  scopes                text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'invalid', 'removed')),
  check_error           text CHECK (length(check_error) <= 500),
  enabled               boolean NOT NULL DEFAULT true,
  followers             bigint,
  following             bigint,
  likes                 bigint,
  video_count           bigint,
  -- What TikTok says the creator may post (creator_info), read before posting and on sync.
  creator               jsonb,
  connected_by          uuid NOT NULL REFERENCES identity.users(id),
  connected_at          timestamptz NOT NULL DEFAULT now(),
  synced_at             timestamptz,
  removed_at            timestamptz,
  CHECK (status <> 'removed' OR (refresh_token_sealed IS NULL AND NOT enabled))
);
CREATE UNIQUE INDEX tiktok_accounts_open_id ON tiktok.accounts (tenant_id, open_id)
  WHERE status <> 'removed';

-- One version of an approved video item going to one account. The same version goes to the same
-- account once (retrying a failed post reuses its row).
CREATE TABLE tiktok.posts (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES identity.tenants(id),
  item_id            uuid NOT NULL REFERENCES content.items(id),
  version            integer NOT NULL CHECK (version >= 1),
  account_id         uuid NOT NULL REFERENCES tiktok.accounts(id),
  -- direct: posted to the profile; draft: sent to the creator's TikTok inbox to finish there.
  mode               text NOT NULL CHECK (mode IN ('direct', 'draft')),
  title              text NOT NULL DEFAULT '' CHECK (length(title) <= 2200),
  privacy            text CHECK (privacy IN ('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS',
                                             'FOLLOWER_OF_CREATOR', 'SELF_ONLY')),
  allow_comment      boolean NOT NULL DEFAULT false,
  allow_duet         boolean NOT NULL DEFAULT false,
  allow_stitch       boolean NOT NULL DEFAULT false,
  -- Commercial content disclosure: promoting the creator's own business, or a paid partnership.
  brand_organic      boolean NOT NULL DEFAULT false,
  branded_content    boolean NOT NULL DEFAULT false,
  aigc               boolean NOT NULL DEFAULT false,
  cover_ms           integer NOT NULL DEFAULT 0 CHECK (cover_ms >= 0),
  scheduled_at       timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled', 'uploading', 'processing', 'published', 'in_inbox', 'failed', 'cancelled')),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    timestamptz NOT NULL,
  locked_until       timestamptz,
  -- What has been done at TikTok so far (publish id, sealed upload address, chunks sent).
  stage              jsonb NOT NULL DEFAULT '{}',
  publish_id         text CHECK (length(publish_id) <= 200),
  post_id            text CHECK (post_id ~ '^[0-9]{1,30}$'),
  warnings           text[] NOT NULL DEFAULT '{}',
  error_code         text CHECK (length(error_code) <= 60),
  error_message      text CHECK (length(error_message) <= 1000),
  created_by         uuid NOT NULL REFERENCES identity.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  published_at       timestamptz,
  CHECK (mode = 'draft' OR privacy IS NOT NULL),
  CHECK (NOT branded_content OR privacy IS DISTINCT FROM 'SELF_ONLY'),
  CHECK (status NOT IN ('published', 'in_inbox') OR publish_id IS NOT NULL)
);
CREATE UNIQUE INDEX tiktok_posts_once ON tiktok.posts (tenant_id, item_id, version, account_id)
  WHERE status <> 'cancelled';
CREATE INDEX tiktok_posts_due ON tiktok.posts (next_attempt_at)
  WHERE status IN ('scheduled', 'uploading', 'processing');
CREATE INDEX tiktok_posts_tenant_time ON tiktok.posts (tenant_id, created_at DESC);

-- The account's own videos with their figures (Display API), for the content report.
CREATE TABLE tiktok.videos (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  account_id     uuid NOT NULL REFERENCES tiktok.accounts(id),
  video_id       text NOT NULL CHECK (video_id ~ '^[0-9]{1,30}$'),
  title          text NOT NULL DEFAULT '' CHECK (length(title) <= 2200),
  cover_url      text CHECK (length(cover_url) <= 2000),
  share_url      text CHECK (length(share_url) <= 2000),
  posted_at      timestamptz,
  duration_sec   integer,
  views          bigint,
  likes          bigint,
  comments       bigint,
  shares         bigint,
  synced_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tiktok_videos_external ON tiktok.videos (account_id, video_id);
CREATE INDEX tiktok_videos_tenant_time ON tiktok.videos (tenant_id, posted_at DESC);

-- TikTok calls go in the same call log as Meta's and Google's.
ALTER TABLE integration.api_calls DROP CONSTRAINT api_calls_provider_check;
ALTER TABLE integration.api_calls ADD CONSTRAINT api_calls_provider_check
  CHECK (provider IN ('meta', 'google', 'tiktok'));
ALTER TABLE integration.api_calls
  ADD COLUMN tiktok_account_id uuid REFERENCES tiktok.accounts(id);

ALTER TABLE tiktok.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok.apps FORCE ROW LEVEL SECURITY;
CREATE POLICY apps_access ON tiktok.apps
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE tiktok.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok.accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_access ON tiktok.accounts
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE tiktok.videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok.videos FORCE ROW LEVEL SECURITY;
CREATE POLICY videos_access ON tiktok.videos
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- The publisher in the API claims due posts across tenants (app.system = 'tiktok_publisher'),
-- then runs each one in the tenant of the person who scheduled it.
ALTER TABLE tiktok.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok.posts FORCE ROW LEVEL SECURITY;
CREATE POLICY posts_access ON tiktok.posts
  USING (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'tiktok_publisher')
  WITH CHECK (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'tiktok_publisher');

GRANT USAGE ON SCHEMA tiktok TO maris_app;
GRANT SELECT, INSERT, UPDATE ON tiktok.apps TO maris_app;
GRANT SELECT, INSERT, UPDATE ON tiktok.accounts TO maris_app;
GRANT SELECT, INSERT, UPDATE ON tiktok.posts TO maris_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tiktok.videos TO maris_app;
