-- Sprint 24 (Phase 7): CRM (spec Part 20, M25) and Meta Lead Ads (Part 14).
-- A contact is one customer of the business, whatever channel they came from: a Lead Ads form,
-- a Messenger or Instagram chat, a comment, or typed in by staff. Each contact moves through a
-- sales pipeline (new → contacted → qualified → won / lost) and keeps a history of activities
-- (notes, stage changes, leads, linked conversations) that is never edited.
-- Leads from Meta Lead Ads arrive by webhook (field "leadgen") and, while the webhook is quiet,
-- a poller reads the newest leads of each form in turn (app.system = 'meta_leads'). Each lead is
-- stored once (its Meta id is unique per tenant) and joined to a contact with the same phone
-- number or email, or to a new one.

INSERT INTO identity.permissions (key, description) VALUES
  ('crm.read', 'Xem khách hàng, lịch sử chăm sóc và lead từ quảng cáo'),
  ('crm.manage', 'Thêm, sửa khách hàng, đổi giai đoạn, phân công và ghi chú');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('crm.read'), ('crm.manage')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager', 'member')
ON CONFLICT DO NOTHING;

CREATE SCHEMA crm;
GRANT USAGE ON SCHEMA crm TO maris_app;

CREATE TABLE crm.contacts (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES identity.tenants(id),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  phone             text CHECK (length(phone) <= 40),
  -- Digits only, Vietnamese numbers as 0xxxxxxxxx: what duplicates are found by.
  phone_norm        text CHECK (phone_norm ~ '^[0-9]{6,20}$'),
  email             text CHECK (length(email) <= 200),
  email_norm        text CHECK (length(email_norm) <= 200),
  stage             text NOT NULL DEFAULT 'new'
                    CHECK (stage IN ('new', 'contacted', 'qualified', 'won', 'lost')),
  source            text NOT NULL
                    CHECK (source IN ('manual', 'lead_ads', 'messenger', 'ig_dm', 'fb_comment', 'ig_comment')),
  owner_id          uuid REFERENCES identity.users(id),
  tags              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  note              text NOT NULL DEFAULT '' CHECK (length(note) <= 4000),
  -- Expected value of the deal in VND, typed by staff.
  value_vnd         bigint CHECK (value_vnd >= 0),
  lost_reason       text CHECK (length(lost_reason) <= 300),
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES identity.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz
);
CREATE INDEX contacts_list ON crm.contacts (tenant_id, last_activity_at DESC) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX contacts_phone ON crm.contacts (tenant_id, phone_norm)
  WHERE phone_norm IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX contacts_email ON crm.contacts (tenant_id, email_norm)
  WHERE email_norm IS NOT NULL AND archived_at IS NULL;

-- The history of a contact. Rows are only added, never changed.
CREATE TABLE crm.activities (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  contact_id  uuid NOT NULL REFERENCES crm.contacts(id),
  kind        text NOT NULL CHECK (kind IN ('created', 'note', 'stage', 'owner', 'lead', 'thread', 'updated', 'archived')),
  body        text NOT NULL DEFAULT '' CHECK (length(body) <= 4000),
  data        jsonb NOT NULL DEFAULT '{}',
  actor_id    uuid REFERENCES identity.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_contact ON crm.activities (contact_id, created_at DESC);

-- A Meta inbox conversation can belong to one contact.
ALTER TABLE meta.threads ADD COLUMN contact_id uuid REFERENCES crm.contacts(id);
CREATE INDEX threads_contact ON meta.threads (contact_id) WHERE contact_id IS NOT NULL;

-- When the lead poller last read each Page.
ALTER TABLE meta.assets ADD COLUMN leads_synced_at timestamptz;

-- Lead Ads forms of a Page.
CREATE TABLE meta.lead_forms (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  asset_id     uuid NOT NULL REFERENCES meta.assets(id),
  external_id  text NOT NULL CHECK (external_id ~ '^[0-9]{1,30}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (length(status) <= 40),
  -- Leads are taken in only from forms that are on; new forms start on.
  enabled      boolean NOT NULL DEFAULT true,
  -- The newest lead time seen, so the next read asks only for newer ones.
  last_lead_at timestamptz,
  synced_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);

-- One lead: the answers a person gave in a Lead Ads form. Phone numbers and emails here are
-- customer data: they are shown to people with crm.read and never written to the audit log.
CREATE TABLE meta.leads (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  form_id        uuid NOT NULL REFERENCES meta.lead_forms(id),
  asset_id       uuid NOT NULL REFERENCES meta.assets(id),
  external_id    text NOT NULL CHECK (external_id ~ '^[0-9]{1,30}$'),
  -- [{name, values}] as Meta gives them.
  fields         jsonb NOT NULL DEFAULT '[]',
  ad_id          text CHECK (length(ad_id) <= 30),
  ad_name        text CHECK (length(ad_name) <= 300),
  campaign_id    text CHECK (length(campaign_id) <= 30),
  campaign_name  text CHECK (length(campaign_name) <= 300),
  is_organic     boolean NOT NULL DEFAULT false,
  platform       text CHECK (length(platform) <= 20),
  lead_at        timestamptz NOT NULL,
  received_via   text NOT NULL CHECK (received_via IN ('webhook', 'sync')),
  contact_id     uuid REFERENCES crm.contacts(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);
CREATE INDEX leads_list ON meta.leads (tenant_id, lead_at DESC);
CREATE INDEX leads_contact ON meta.leads (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE crm.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY contacts_access ON crm.contacts
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE crm.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.activities FORCE ROW LEVEL SECURITY;
CREATE POLICY activities_access ON crm.activities
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE meta.lead_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.lead_forms FORCE ROW LEVEL SECURITY;
CREATE POLICY lead_forms_access ON meta.lead_forms
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE meta.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.leads FORCE ROW LEVEL SECURITY;
CREATE POLICY leads_access ON meta.leads
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- The lead poller only needs to know which tenants have an active Facebook connection, and who made it.
CREATE POLICY connections_leads_poller ON meta.connections FOR SELECT
  USING (current_setting('app.system', true) = 'meta_leads');

GRANT SELECT, INSERT, UPDATE ON crm.contacts TO maris_app;
GRANT SELECT, INSERT ON crm.activities TO maris_app;
GRANT SELECT, INSERT, UPDATE ON meta.lead_forms TO maris_app;
GRANT SELECT, INSERT, UPDATE ON meta.leads TO maris_app;
