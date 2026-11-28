-- Sprint 25 (Phase 7): Meta Ads Command Center (spec Part 19, M23) and spend analysis (Part 14).
-- MARIS reads the campaigns, ad sets and ads of each enabled ad account and their daily figures
-- (spend, impressions, clicks, results) by campaign, through the API Governor (group ads_insights),
-- one account at a time in turn, about every 30 minutes (Part 15 schedule).
-- Changes sent to Meta (pause, turn on, daily budget) are rows of meta.ad_changes: a change that
-- would take a daily budget above the limit approved for the account waits for a person with
-- ads.approve (Part 19: never raise a budget beyond the approved limit on its own). Figures about
-- purchases and their value are what Meta reports, not revenue the business has received.

INSERT INTO identity.permissions (key, description) VALUES
  ('ads.read', 'Xem chiến dịch quảng cáo, chi tiêu và phân tích'),
  ('ads.manage', 'Tạm dừng, bật lại quảng cáo và đổi ngân sách trong giới hạn đã duyệt'),
  ('ads.approve', 'Đặt giới hạn ngân sách và duyệt thay đổi vượt giới hạn');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('ads.read'), ('ads.manage')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager')
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'ads.approve'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

-- Per ad account: when it was last read, and the highest daily budget (in Meta's minor units of
-- the account currency, e.g. VND itself, US cents) one campaign or ad set may have without approval.
-- Null: every raise and every turn-on needs approval.
ALTER TABLE meta.assets ADD COLUMN ads_synced_at timestamptz;
ALTER TABLE meta.assets ADD COLUMN ads_structure_at timestamptz;
ALTER TABLE meta.assets ADD COLUMN ads_daily_cap bigint CHECK (ads_daily_cap >= 0);
ALTER TABLE meta.assets ADD COLUMN ads_error text CHECK (length(ads_error) <= 500);

-- Campaigns, ad sets and ads as Meta last described them.
CREATE TABLE meta.ad_objects (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES identity.tenants(id),
  asset_id         uuid NOT NULL REFERENCES meta.assets(id),
  level            text NOT NULL CHECK (level IN ('campaign', 'adset', 'ad')),
  external_id      text NOT NULL CHECK (external_id ~ '^[0-9]{1,30}$'),
  -- The campaign of an ad set or ad, and the ad set of an ad.
  campaign_id      uuid REFERENCES meta.ad_objects(id),
  adset_id         uuid REFERENCES meta.ad_objects(id),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 400),
  -- What was set (ACTIVE, PAUSED, ARCHIVED, DELETED) and what Meta says is happening
  -- (ACTIVE, PAUSED, CAMPAIGN_PAUSED, DISAPPROVED, PENDING_REVIEW, WITH_ISSUES...).
  status           text NOT NULL CHECK (status ~ '^[A-Z_]{1,40}$'),
  effective_status text NOT NULL CHECK (effective_status ~ '^[A-Z_]{1,40}$'),
  objective        text CHECK (length(objective) <= 60),
  daily_budget     bigint CHECK (daily_budget >= 0),
  lifetime_budget  bigint CHECK (lifetime_budget >= 0),
  -- Still listed by Meta at the last read.
  present          boolean NOT NULL DEFAULT true,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX ad_objects_account ON meta.ad_objects (asset_id, level);
CREATE INDEX ad_objects_campaign ON meta.ad_objects (campaign_id) WHERE campaign_id IS NOT NULL;

-- Daily figures of one campaign, on the date of the ad account's time zone. Re-read for the last
-- few days at every pass because Meta keeps updating recent days.
CREATE TABLE meta.ad_insights (
  tenant_id       uuid NOT NULL REFERENCES identity.tenants(id),
  asset_id        uuid NOT NULL REFERENCES meta.assets(id),
  object_id       uuid NOT NULL REFERENCES meta.ad_objects(id),
  day             date NOT NULL,
  -- Account currency, major units, as Meta reports it.
  spend           numeric(18, 2) NOT NULL DEFAULT 0 CHECK (spend >= 0),
  impressions     bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  reach           bigint NOT NULL DEFAULT 0 CHECK (reach >= 0),
  clicks          bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  link_clicks     bigint NOT NULL DEFAULT 0 CHECK (link_clicks >= 0),
  -- Reported by Meta (pixel, Lead Ads, Messenger); not revenue received.
  purchases       bigint NOT NULL DEFAULT 0 CHECK (purchases >= 0),
  purchase_value  numeric(18, 2) NOT NULL DEFAULT 0 CHECK (purchase_value >= 0),
  leads           bigint NOT NULL DEFAULT 0 CHECK (leads >= 0),
  messages        bigint NOT NULL DEFAULT 0 CHECK (messages >= 0),
  synced_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_id, day)
);
CREATE INDEX ad_insights_account_day ON meta.ad_insights (tenant_id, asset_id, day);

-- Every change MARIS asks Meta to make, with who asked and who approved.
CREATE TABLE meta.ad_changes (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  object_id      uuid NOT NULL REFERENCES meta.ad_objects(id),
  kind           text NOT NULL CHECK (kind IN ('status', 'daily_budget')),
  -- status: ACTIVE or PAUSED; daily_budget: minor units as text.
  from_value     text CHECK (length(from_value) <= 40),
  to_value       text NOT NULL CHECK (length(to_value) BETWEEN 1 AND 40),
  reason         text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'applying', 'applied', 'failed', 'rejected', 'cancelled')),
  -- Why it needed approval: above the account limit, or no limit set.
  needs_approval boolean NOT NULL DEFAULT false,
  requested_by   uuid REFERENCES identity.users(id),
  decided_by     uuid REFERENCES identity.users(id),
  decision_note  text CHECK (length(decision_note) <= 500),
  error          text CHECK (length(error) <= 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz,
  applied_at     timestamptz
);
CREATE INDEX ad_changes_list ON meta.ad_changes (tenant_id, created_at DESC);
-- One open change of each kind per object.
CREATE UNIQUE INDEX ad_changes_open ON meta.ad_changes (object_id, kind)
  WHERE status IN ('pending', 'applying');

ALTER TABLE meta.ad_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.ad_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY ad_objects_access ON meta.ad_objects
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE meta.ad_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.ad_insights FORCE ROW LEVEL SECURITY;
CREATE POLICY ad_insights_access ON meta.ad_insights
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE meta.ad_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.ad_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY ad_changes_access ON meta.ad_changes
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- The ads poller only needs to know which tenants have an active Facebook connection, and who made it.
CREATE POLICY connections_ads_poller ON meta.connections FOR SELECT
  USING (current_setting('app.system', true) = 'meta_ads');

GRANT SELECT, INSERT, UPDATE ON meta.ad_objects TO maris_app;
GRANT SELECT, INSERT, UPDATE ON meta.ad_insights TO maris_app;
GRANT SELECT, INSERT, UPDATE ON meta.ad_changes TO maris_app;
