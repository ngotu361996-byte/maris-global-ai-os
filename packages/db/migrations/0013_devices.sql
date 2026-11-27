-- Sprint 13 (Phase 5): devices and workers (spec Part 26). A device is a machine that runs the MARIS
-- worker: the central VPS, an admin or staff PC, a GPU, media or local AI worker. An administrator
-- creates the device and gets a one-time pairing string; the worker trades it for a device token
-- (only hashes are stored). The worker always connects out to the server and reports its resources;
-- the server never opens a shell or a remote desktop on it.

INSERT INTO identity.permissions (key, description) VALUES
  ('infra.read', 'Xem thiết bị, Worker và tài nguyên'),
  ('infra.manage', 'Thêm, tạm dừng, thu hồi, xóa thiết bị và Worker');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r CROSS JOIN (VALUES ('infra.read'), ('infra.manage')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

CREATE SCHEMA IF NOT EXISTS infra;

CREATE TABLE infra.devices (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES identity.tenants(id),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind                text NOT NULL CHECK (kind IN ('server', 'admin_pc', 'staff_pc', 'gpu_worker',
                                                    'media_worker', 'local_ai_worker', 'code_runner')),
  -- pending: created, waiting for the worker to pair; active; paused; revoked (token no longer works).
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'paused', 'revoked')),
  pairing_hash        text CHECK (pairing_hash ~ '^[0-9a-f]{64}$'),
  pairing_expires_at  timestamptz,
  token_hash          text CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- What the worker reported when it paired: hostname, OS, CPU, RAM, GPUs, agent version.
  info                jsonb NOT NULL DEFAULT '{}',
  last_seen_at        timestamptz,
  last_ip             text CHECK (length(last_ip) <= 64),
  paired_at           timestamptz,
  created_by          uuid NOT NULL REFERENCES identity.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX devices_tenant ON infra.devices (tenant_id) WHERE deleted_at IS NULL;

-- One sample per heartbeat; samples older than a day are deleted as new ones arrive.
CREATE TABLE infra.device_metrics (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  device_id      uuid NOT NULL REFERENCES infra.devices(id),
  cpu_pct        real CHECK (cpu_pct BETWEEN 0 AND 100),
  ram_used_mb    integer CHECK (ram_used_mb >= 0),
  ram_total_mb   integer CHECK (ram_total_mb >= 0),
  disk_used_gb   real CHECK (disk_used_gb >= 0),
  disk_total_gb  real CHECK (disk_total_gb >= 0),
  -- [{index, name, utilPct, memUsedMb, memTotalMb, tempC}]
  gpus           jsonb NOT NULL DEFAULT '[]',
  cpu_temp_c     real,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_metrics_device ON infra.device_metrics (tenant_id, device_id, recorded_at DESC);

-- What happened to a device: paired, reconnected after a gap, paused, revoked, warnings.
CREATE TABLE infra.device_events (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  device_id   uuid NOT NULL REFERENCES infra.devices(id),
  level       text NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  kind        text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  message     text NOT NULL CHECK (length(message) <= 500),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_events_device ON infra.device_events (tenant_id, device_id, created_at DESC);

ALTER TABLE infra.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE infra.devices FORCE ROW LEVEL SECURITY;
CREATE POLICY devices_access ON infra.devices
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE infra.device_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE infra.device_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY device_metrics_access ON infra.device_metrics
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE infra.device_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE infra.device_events FORCE ROW LEVEL SECURITY;
CREATE POLICY device_events_access ON infra.device_events
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT USAGE ON SCHEMA infra TO maris_app;
GRANT SELECT, INSERT, UPDATE ON infra.devices TO maris_app;
GRANT SELECT, INSERT, DELETE ON infra.device_metrics TO maris_app;
GRANT SELECT, INSERT ON infra.device_events TO maris_app;
