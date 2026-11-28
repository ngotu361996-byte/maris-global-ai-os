-- Sprint 29 (Phase 8): Website and SEO Center (spec Part 16 GA4 and Search Console, Part 18
-- website checks, M21).
-- A tenant adds its websites. Each site can be linked to a Google Analytics 4 property and a
-- Search Console property, read through a Google account already signed in on the Google Center
-- with the "Analytics" or "Search Console" service (read-only scopes). MARIS reads daily numbers,
-- top pages, sources, search queries and sitemaps on a schedule and on request, and keeps them
-- here so reports come from the MARIS database.
-- A website check reads the site's own pages (home page, sitemap, internal links, a limited
-- number) and records broken links, HTTP errors, slow pages and missing SEO tags. It only reads
-- public pages over http(s) and never private network addresses.

INSERT INTO identity.permissions (key, description) VALUES
  ('web.read', 'Xem website, số liệu Google Analytics 4, Search Console và kết quả kiểm tra'),
  ('web.manage', 'Thêm, sửa, gỡ website, liên kết GA4 và Search Console, đọc số liệu và kiểm tra website');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'web.read'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager')
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'web.manage'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

CREATE SCHEMA IF NOT EXISTS web;

-- A website of the tenant.
CREATE TABLE web.sites (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES identity.tenants(id),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- The site's home page, http(s) only.
  url                text NOT NULL CHECK (url ~ '^https?://[^\s/]+/?$' AND length(url) <= 300),
  -- GA4: "properties/123", read through this Google connection.
  ga4_property       text CHECK (ga4_property ~ '^properties/[0-9]{1,20}$'),
  ga4_name           text CHECK (length(ga4_name) <= 200),
  ga4_connection_id  uuid REFERENCES google.connections(id),
  -- Search Console: "sc-domain:example.com" or a URL-prefix property "https://example.com/".
  gsc_site           text CHECK (length(gsc_site) BETWEEN 1 AND 300),
  gsc_connection_id  uuid REFERENCES google.connections(id),
  -- The latest sitemaps Search Console reports for the site.
  gsc_sitemaps       jsonb NOT NULL DEFAULT '[]',
  currency           text CHECK (currency ~ '^[A-Z]{3}$'),
  enabled            boolean NOT NULL DEFAULT true,
  synced_at          timestamptz,
  sync_error         text CHECK (length(sync_error) <= 500),
  created_by         uuid NOT NULL REFERENCES identity.users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  removed_at         timestamptz,
  CHECK ((ga4_property IS NULL) = (ga4_connection_id IS NULL)),
  CHECK ((gsc_site IS NULL) = (gsc_connection_id IS NULL))
);
CREATE UNIQUE INDEX web_sites_url ON web.sites (tenant_id, url) WHERE removed_at IS NULL;

-- GA4 numbers for a day (the property's own time zone).
CREATE TABLE web.ga4_daily (
  site_id          uuid NOT NULL REFERENCES web.sites(id),
  tenant_id        uuid NOT NULL REFERENCES identity.tenants(id),
  day              date NOT NULL,
  sessions         integer NOT NULL CHECK (sessions >= 0),
  users            integer NOT NULL CHECK (users >= 0),
  new_users        integer NOT NULL CHECK (new_users >= 0),
  views            integer NOT NULL CHECK (views >= 0),
  key_events       numeric(14, 2) NOT NULL CHECK (key_events >= 0),
  engagement_rate  numeric(6, 4) NOT NULL CHECK (engagement_rate BETWEEN 0 AND 1),
  PRIMARY KEY (site_id, day)
);

-- Search Console numbers for a day (Google Search, web results).
CREATE TABLE web.gsc_daily (
  site_id      uuid NOT NULL REFERENCES web.sites(id),
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  day          date NOT NULL,
  clicks       integer NOT NULL CHECK (clicks >= 0),
  impressions  integer NOT NULL CHECK (impressions >= 0),
  ctr          numeric(7, 6) NOT NULL CHECK (ctr BETWEEN 0 AND 1),
  position     numeric(8, 2) NOT NULL CHECK (position >= 0),
  PRIMARY KEY (site_id, day)
);

-- The top rows of the last 28 days, replaced at each read: GA4 pages and channels, Search
-- Console queries and pages. a, b, c, d hold the numbers of the kind (see the contracts).
CREATE TABLE web.tops (
  site_id    uuid NOT NULL REFERENCES web.sites(id),
  tenant_id  uuid NOT NULL REFERENCES identity.tenants(id),
  kind       text NOT NULL CHECK (kind IN ('ga4_page', 'ga4_channel', 'gsc_query', 'gsc_page')),
  key        text NOT NULL CHECK (length(key) BETWEEN 1 AND 500),
  rank       integer NOT NULL CHECK (rank >= 1),
  a          numeric(16, 4) NOT NULL DEFAULT 0,
  b          numeric(16, 4) NOT NULL DEFAULT 0,
  c          numeric(16, 4) NOT NULL DEFAULT 0,
  d          numeric(16, 4) NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, kind, key)
);

-- A website check run.
CREATE TABLE web.checks (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  site_id        uuid NOT NULL REFERENCES web.sites(id),
  status         text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  pages          integer NOT NULL DEFAULT 0 CHECK (pages >= 0),
  links          integer NOT NULL DEFAULT 0 CHECK (links >= 0),
  errors         integer NOT NULL DEFAULT 0 CHECK (errors >= 0),
  warnings       integer NOT NULL DEFAULT 0 CHECK (warnings >= 0),
  -- Slowest and average time to the first full answer of a page, in milliseconds.
  avg_ms         integer CHECK (avg_ms >= 0),
  max_ms         integer CHECK (max_ms >= 0),
  error          text CHECK (length(error) <= 500),
  requested_by   uuid NOT NULL REFERENCES identity.users(id),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX web_checks_site ON web.checks (site_id, started_at DESC);

-- What a check found, one row per page and problem.
CREATE TABLE web.check_issues (
  id         uuid PRIMARY KEY,
  check_id   uuid NOT NULL REFERENCES web.checks(id),
  tenant_id  uuid NOT NULL REFERENCES identity.tenants(id),
  severity   text NOT NULL CHECK (severity IN ('error', 'warning')),
  kind       text NOT NULL CHECK (kind ~ '^[a-z0-9_]{1,40}$'),
  url        text NOT NULL CHECK (length(url) <= 1000),
  detail     text NOT NULL DEFAULT '' CHECK (length(detail) <= 500)
);
CREATE INDEX web_check_issues_check ON web.check_issues (check_id);

-- The reader lists sites across tenants (app.system = 'web_sync'), then reads each one in its
-- tenant.
ALTER TABLE web.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE web.sites FORCE ROW LEVEL SECURITY;
CREATE POLICY sites_access ON web.sites
  USING (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'web_sync')
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE web.ga4_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE web.ga4_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY ga4_daily_access ON web.ga4_daily
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE web.gsc_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE web.gsc_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY gsc_daily_access ON web.gsc_daily
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE web.tops ENABLE ROW LEVEL SECURITY;
ALTER TABLE web.tops FORCE ROW LEVEL SECURITY;
CREATE POLICY tops_access ON web.tops
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE web.checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE web.checks FORCE ROW LEVEL SECURITY;
CREATE POLICY checks_access ON web.checks
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE web.check_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE web.check_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY check_issues_access ON web.check_issues
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT USAGE ON SCHEMA web TO maris_app;
GRANT SELECT, INSERT, UPDATE ON web.sites TO maris_app;
-- A site linked to another property starts again with that property's numbers.
GRANT SELECT, INSERT, UPDATE, DELETE ON web.ga4_daily TO maris_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON web.gsc_daily TO maris_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON web.tops TO maris_app;
GRANT SELECT, INSERT, UPDATE ON web.checks TO maris_app;
GRANT SELECT, INSERT ON web.check_issues TO maris_app;
