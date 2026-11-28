-- Sprint 28 (Phase 8): Shopify and POSCake (spec Part 18, M22 and M26).
-- A tenant connects its own stores. Shopify: an app made in the store's Dev Dashboard, installed
-- on the store; MARIS exchanges its Client ID and Client secret (in the Secret Vault) for a
-- 24-hour Admin API token (client credentials grant), kept in memory only. POSCake (Pancake POS):
-- a shop API key, kept in the Secret Vault and sent only to POSCake.
-- MARIS reads products, variants (SKU, price, stock per location or warehouse) and orders on a
-- schedule and on request. Order buyers join CRM contacts by phone number or email. Products are
-- compared across stores by SKU. Changing a price or a stock level on Shopify needs its own
-- permission, is checked against the value the person saw (so nobody overwrites a newer change),
-- and is recorded. POSCake is read only.

INSERT INTO identity.permissions (key, description) VALUES
  ('commerce.read', 'Xem cửa hàng Shopify và POSCake: sản phẩm, tồn kho, đơn hàng, số liệu'),
  ('commerce.manage', 'Kết nối, ngắt, bật tắt cửa hàng Shopify và POSCake, đọc dữ liệu ngay'),
  ('commerce.write', 'Đổi giá bán và số tồn kho trên cửa hàng Shopify');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'commerce.read'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager')
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('commerce.manage'), ('commerce.write')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

CREATE SCHEMA IF NOT EXISTS commerce;

-- A connected store.
CREATE TABLE commerce.stores (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES identity.tenants(id),
  platform        text NOT NULL CHECK (platform IN ('shopify', 'poscake')),
  -- Shopify: the store's myshopify.com domain. POSCake: the shop id.
  external_id     text NOT NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Shopify only: the app's Client ID.
  client_id       text CHECK (client_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  -- The Secret Vault name of the Shopify Client secret or the POSCake API key.
  secret_name     text NOT NULL CHECK (length(secret_name) BETWEEN 1 AND 100),
  currency        text NOT NULL DEFAULT 'VND' CHECK (currency ~ '^[A-Z]{3}$'),
  -- Shopify: the access scopes the store granted the app.
  scopes          text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid', 'removed')),
  check_error     text CHECK (length(check_error) <= 500),
  enabled         boolean NOT NULL DEFAULT true,
  -- Orders updated after this time are read next (it moves forward with each read).
  orders_cursor   timestamptz,
  synced_at       timestamptz,
  sync_error      text CHECK (length(sync_error) <= 500),
  connected_by    uuid NOT NULL REFERENCES identity.users(id),
  connected_at    timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  CHECK (
    (platform = 'shopify' AND client_id IS NOT NULL
      AND external_id ~ '^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$')
    OR (platform = 'poscake' AND client_id IS NULL AND external_id ~ '^[0-9]{1,20}$')
  ),
  CHECK (status <> 'removed' OR NOT enabled)
);
CREATE UNIQUE INDEX commerce_stores_external ON commerce.stores (tenant_id, platform, external_id)
  WHERE status <> 'removed';

-- Shopify locations and POSCake warehouses.
CREATE TABLE commerce.locations (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  store_id     uuid NOT NULL REFERENCES commerce.stores(id),
  external_id  text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  name         text NOT NULL CHECK (length(name) <= 300),
  active       boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX commerce_locations_external ON commerce.locations (store_id, external_id);

CREATE TABLE commerce.products (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES identity.tenants(id),
  store_id      uuid NOT NULL REFERENCES commerce.stores(id),
  external_id   text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  title         text NOT NULL CHECK (length(title) <= 500),
  -- Shopify: ACTIVE, DRAFT, ARCHIVED. POSCake: active or locked.
  status        text NOT NULL CHECK (length(status) <= 40),
  product_type  text CHECK (length(product_type) <= 200),
  vendor        text CHECK (length(vendor) <= 200),
  -- Still in the store at the last full read.
  present       boolean NOT NULL DEFAULT true,
  synced_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commerce_products_external ON commerce.products (store_id, external_id);

-- One sellable variant (a size, a colour): the unit with a SKU, a price and stock.
CREATE TABLE commerce.variants (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES identity.tenants(id),
  store_id           uuid NOT NULL REFERENCES commerce.stores(id),
  product_id         uuid NOT NULL REFERENCES commerce.products(id),
  external_id        text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  title              text NOT NULL CHECK (length(title) <= 500),
  sku                text CHECK (length(sku) <= 200),
  -- The SKU without spaces, in capitals: how stores are matched.
  sku_norm           text CHECK (length(sku_norm) <= 200),
  barcode            text CHECK (length(barcode) <= 200),
  price              numeric(16, 2) NOT NULL CHECK (price >= 0),
  compare_at         numeric(16, 2) CHECK (compare_at >= 0),
  -- Shopify's inventory item, needed to change stock.
  inventory_item_id  text CHECK (length(inventory_item_id) <= 200),
  -- Available to sell, over all locations; null when the store does not track it.
  available          integer,
  present            boolean NOT NULL DEFAULT true,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commerce_variants_external ON commerce.variants (store_id, external_id);
CREATE INDEX commerce_variants_sku ON commerce.variants (tenant_id, sku_norm) WHERE present;

-- Stock of a variant at one location.
CREATE TABLE commerce.stock (
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  variant_id   uuid NOT NULL REFERENCES commerce.variants(id),
  location_id  uuid NOT NULL REFERENCES commerce.locations(id),
  available    integer NOT NULL,
  PRIMARY KEY (variant_id, location_id)
);

CREATE TABLE commerce.orders (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES identity.tenants(id),
  store_id      uuid NOT NULL REFERENCES commerce.stores(id),
  external_id   text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 200),
  -- What the store shows (Shopify "#1001", POSCake's order number).
  number        text NOT NULL CHECK (length(number) <= 100),
  state         text NOT NULL
                CHECK (state IN ('new', 'confirmed', 'shipping', 'completed', 'returned', 'cancelled')),
  -- The store's own status words.
  raw_status    text NOT NULL CHECK (length(raw_status) <= 200),
  total         numeric(16, 2) NOT NULL DEFAULT 0,
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  customer_name text CHECK (length(customer_name) <= 200),
  phone         text CHECK (length(phone) <= 40),
  email         text CHECK (length(email) <= 200),
  contact_id    uuid REFERENCES crm.contacts(id),
  -- [{sku, title, quantity, price}]
  items         jsonb NOT NULL DEFAULT '[]',
  placed_at     timestamptz NOT NULL,
  updated_ext   timestamptz NOT NULL,
  synced_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX commerce_orders_external ON commerce.orders (store_id, external_id);
CREATE INDEX commerce_orders_tenant_time ON commerce.orders (tenant_id, placed_at DESC);

-- Price and stock changes MARIS made on a store, with what was there before.
CREATE TABLE commerce.changes (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES identity.tenants(id),
  store_id      uuid NOT NULL REFERENCES commerce.stores(id),
  variant_id    uuid NOT NULL REFERENCES commerce.variants(id),
  kind          text NOT NULL CHECK (kind IN ('price', 'stock')),
  location_id   uuid REFERENCES commerce.locations(id),
  old_value     numeric(16, 2) NOT NULL,
  new_value     numeric(16, 2) NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('done', 'failed', 'conflict')),
  error         text CHECK (length(error) <= 500),
  requested_by  uuid NOT NULL REFERENCES identity.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'stock') = (location_id IS NOT NULL))
);
CREATE INDEX commerce_changes_tenant_time ON commerce.changes (tenant_id, created_at DESC);

-- Store calls go in the same call log as Meta's, Google's and TikTok's.
ALTER TABLE integration.api_calls DROP CONSTRAINT api_calls_provider_check;
ALTER TABLE integration.api_calls ADD CONSTRAINT api_calls_provider_check
  CHECK (provider IN ('meta', 'google', 'tiktok', 'shopify', 'poscake'));
ALTER TABLE integration.api_calls
  ADD COLUMN commerce_store_id uuid REFERENCES commerce.stores(id);

-- Buyers of store orders become CRM contacts; each order is in the contact's history.
ALTER TABLE crm.contacts DROP CONSTRAINT contacts_source_check;
ALTER TABLE crm.contacts ADD CONSTRAINT contacts_source_check
  CHECK (source IN ('manual', 'lead_ads', 'messenger', 'ig_dm', 'fb_comment', 'ig_comment',
                    'shopify', 'poscake'));
ALTER TABLE crm.activities DROP CONSTRAINT activities_kind_check;
ALTER TABLE crm.activities ADD CONSTRAINT activities_kind_check
  CHECK (kind IN ('created', 'note', 'stage', 'owner', 'lead', 'thread', 'updated', 'archived',
                  'order'));

-- The reader lists stores across tenants (app.system = 'commerce_sync'), then reads each one in
-- its tenant.
ALTER TABLE commerce.stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.stores FORCE ROW LEVEL SECURITY;
CREATE POLICY stores_access ON commerce.stores
  USING (tenant_id = maris_ctx.tenant_id() OR current_setting('app.system', true) = 'commerce_sync')
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE commerce.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.locations FORCE ROW LEVEL SECURITY;
CREATE POLICY locations_access ON commerce.locations
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE commerce.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.products FORCE ROW LEVEL SECURITY;
CREATE POLICY products_access ON commerce.products
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE commerce.variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.variants FORCE ROW LEVEL SECURITY;
CREATE POLICY variants_access ON commerce.variants
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE commerce.stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.stock FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_access ON commerce.stock
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE commerce.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_access ON commerce.orders
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE commerce.changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.changes FORCE ROW LEVEL SECURITY;
CREATE POLICY changes_access ON commerce.changes
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT USAGE ON SCHEMA commerce TO maris_app;
GRANT SELECT, INSERT, UPDATE ON commerce.stores TO maris_app;
GRANT SELECT, INSERT, UPDATE ON commerce.locations TO maris_app;
GRANT SELECT, INSERT, UPDATE ON commerce.products TO maris_app;
GRANT SELECT, INSERT, UPDATE ON commerce.variants TO maris_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON commerce.stock TO maris_app;
GRANT SELECT, INSERT, UPDATE ON commerce.orders TO maris_app;
GRANT SELECT, INSERT ON commerce.changes TO maris_app;
