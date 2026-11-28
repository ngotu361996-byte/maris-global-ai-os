-- Sprint 26 (Phase 8): Google Center (spec Part 16, M18) and YouTube Center (Part 17, M20).
-- A tenant registers its own Google Cloud OAuth client (client ID here, client secret in the
-- Secret Vault) and signs in Google accounts through Google's own consent screen, asking for each
-- service separately. A feature is ready only for the scopes Google granted. Refresh tokens are
-- sealed with the vault key and never leave the server.
-- YouTube channels of the signed-in accounts are synced; at most 10 are turned on. Approved video
-- items are uploaded with YouTube's resumable upload; a scheduled video is uploaded at once as
-- private and YouTube itself makes it public at the chosen time (status.publishAt), so the
-- computer running MARIS does not need to be on at that time.
-- Calls to Google are recorded in integration.api_calls with the quota units they count for. The
-- YouTube quota (10,000 units a day by default) is counted from midnight Pacific time.

INSERT INTO identity.permissions (key, description) VALUES
  ('google.read', 'Xem Trung tâm Google và YouTube: tài khoản, kênh, hạn mức API'),
  ('google.manage', 'Cài OAuth client Google, kết nối và ngắt tài khoản Google, bật tắt kênh'),
  ('google.publish', 'Tải video và Shorts lên YouTube, hủy và tải lại');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('google.read'), ('google.publish')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager')
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'google.manage'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

CREATE SCHEMA IF NOT EXISTS google;

-- The Google Cloud OAuth client a tenant signs in with.
CREATE TABLE google.apps (
  tenant_id           uuid PRIMARY KEY REFERENCES identity.tenants(id),
  client_id           text NOT NULL
                      CHECK (client_id ~ '^[0-9]{5,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$'),
  client_secret_name  text NOT NULL CHECK (length(client_secret_name) BETWEEN 1 AND 100),
  youtube_quota       integer NOT NULL DEFAULT 10000 CHECK (youtube_quota BETWEEN 100 AND 10000000),
  youtube_audited     boolean NOT NULL DEFAULT false,
  updated_by          uuid NOT NULL REFERENCES identity.users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Google accounts signed in. Several at a time: each YouTube brand account signs in on its own.
CREATE TABLE google.connections (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES identity.tenants(id),
  -- Google's stable account id ("sub").
  google_sub            text NOT NULL CHECK (google_sub ~ '^[0-9]{1,40}$'),
  email                 text NOT NULL CHECK (length(email) <= 320),
  name                  text NOT NULL CHECK (length(name) <= 200),
  -- Refresh token, sealed with the vault key (AES-256-GCM, bound to tenant and row).
  refresh_token_sealed  text,
  scopes                text[] NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'invalid', 'removed')),
  check_error           text CHECK (length(check_error) <= 500),
  connected_by          uuid NOT NULL REFERENCES identity.users(id),
  connected_at          timestamptz NOT NULL DEFAULT now(),
  synced_at             timestamptz,
  removed_at            timestamptz,
  CHECK (status <> 'removed' OR refresh_token_sealed IS NULL)
);
CREATE UNIQUE INDEX google_connections_account ON google.connections (tenant_id, google_sub)
  WHERE status <> 'removed';

-- YouTube channels the signed-in accounts own.
CREATE TABLE google.channels (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES identity.tenants(id),
  connection_id   uuid NOT NULL REFERENCES google.connections(id),
  channel_id      text NOT NULL CHECK (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  title           text NOT NULL CHECK (length(title) <= 300),
  custom_url      text CHECK (length(custom_url) <= 200),
  thumbnail_url   text CHECK (length(thumbnail_url) <= 2000),
  subscribers     bigint,
  videos          bigint,
  views           bigint,
  long_uploads    text CHECK (length(long_uploads) <= 40),
  enabled         boolean NOT NULL DEFAULT false,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  CHECK (removed_at IS NULL OR NOT enabled)
);
CREATE UNIQUE INDEX google_channels_external ON google.channels (tenant_id, channel_id);

-- One version of an approved video item going to one channel. The same version goes to the same
-- channel once (retrying a failed upload reuses its row).
CREATE TABLE google.youtube_uploads (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES identity.tenants(id),
  item_id            uuid NOT NULL REFERENCES content.items(id),
  version            integer NOT NULL CHECK (version >= 1),
  channel_id         uuid NOT NULL REFERENCES google.channels(id),
  format             text NOT NULL CHECK (format IN ('video', 'short')),
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  description        text NOT NULL DEFAULT '' CHECK (octet_length(description) <= 5000),
  tags               text[] NOT NULL DEFAULT '{}',
  category_id        text NOT NULL CHECK (category_id ~ '^[0-9]{1,3}$'),
  privacy            text NOT NULL CHECK (privacy IN ('public', 'unlisted', 'private')),
  publish_at         timestamptz,
  made_for_kids      boolean NOT NULL,
  synthetic_media    boolean NOT NULL DEFAULT false,
  thumbnail_item_id  uuid REFERENCES content.items(id),
  thumbnail_version  integer,
  status             text NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled', 'uploading', 'processing', 'published', 'failed', 'cancelled')),
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at    timestamptz NOT NULL,
  locked_until       timestamptz,
  -- What has been done at YouTube so far (the sealed upload session, bytes sent, video id).
  stage              jsonb NOT NULL DEFAULT '{}',
  video_id           text CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  youtube_privacy    text CHECK (length(youtube_privacy) <= 20),
  warnings           text[] NOT NULL DEFAULT '{}',
  error_code         text CHECK (length(error_code) <= 60),
  error_message      text CHECK (length(error_message) <= 1000),
  created_by         uuid NOT NULL REFERENCES identity.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  published_at       timestamptz,
  CHECK (status <> 'published' OR video_id IS NOT NULL),
  CHECK (publish_at IS NULL OR privacy = 'public')
);
CREATE UNIQUE INDEX youtube_uploads_once ON google.youtube_uploads (tenant_id, item_id, version, channel_id)
  WHERE status <> 'cancelled';
CREATE INDEX youtube_uploads_due ON google.youtube_uploads (next_attempt_at)
  WHERE status IN ('scheduled', 'uploading', 'processing');
CREATE INDEX youtube_uploads_tenant_time ON google.youtube_uploads (tenant_id, created_at DESC);

-- Google calls go in the same call log as Meta's, with the quota units they count for.
ALTER TABLE integration.api_calls DROP CONSTRAINT api_calls_provider_check;
ALTER TABLE integration.api_calls ADD CONSTRAINT api_calls_provider_check
  CHECK (provider IN ('meta', 'google'));
ALTER TABLE integration.api_calls DROP CONSTRAINT api_calls_method_check;
ALTER TABLE integration.api_calls ADD CONSTRAINT api_calls_method_check
  CHECK (method IN ('GET', 'POST', 'PUT', 'DELETE'));
ALTER TABLE integration.api_calls
  ADD COLUMN units integer NOT NULL DEFAULT 0 CHECK (units >= 0),
  ADD COLUMN google_channel_id uuid REFERENCES google.channels(id);
CREATE INDEX api_calls_google_units ON integration.api_calls (tenant_id, created_at)
  WHERE provider = 'google' AND outcome <> 'refused';

ALTER TABLE google.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE google.apps FORCE ROW LEVEL SECURITY;
CREATE POLICY apps_access ON google.apps
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE google.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE google.connections FORCE ROW LEVEL SECURITY;
CREATE POLICY connections_access ON google.connections
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE google.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE google.channels FORCE ROW LEVEL SECURITY;
CREATE POLICY channels_access ON google.channels
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- The uploader in the API claims due uploads across tenants (app.system = 'youtube_uploader'),
-- then runs each one in the tenant of the person who scheduled it.
ALTER TABLE google.youtube_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE google.youtube_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY youtube_uploads_access ON google.youtube_uploads
  USING (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'youtube_uploader')
  WITH CHECK (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'youtube_uploader');

GRANT USAGE ON SCHEMA google TO maris_app;
GRANT SELECT, INSERT, UPDATE ON google.apps TO maris_app;
GRANT SELECT, INSERT, UPDATE ON google.connections TO maris_app;
GRANT SELECT, INSERT, UPDATE ON google.channels TO maris_app;
GRANT SELECT, INSERT, UPDATE ON google.youtube_uploads TO maris_app;
