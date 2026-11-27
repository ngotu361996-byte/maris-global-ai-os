-- Sprint 14 (Phase 5): work for workers (spec Part 26: distribute jobs, resource limits, pause,
-- move a job to another worker, logs, error alerts). A job is one of a fixed set of kinds that the
-- worker program itself implements; there is no job that runs a shell command. Workers poll for
-- work and hold a lease while they run it; a lease that runs out puts the job back in the queue
-- for another worker, up to max_attempts.

-- How many jobs a device may run at once (its resource limit), and the job kinds it says it can run.
ALTER TABLE infra.devices
  ADD COLUMN max_jobs     integer NOT NULL DEFAULT 1 CHECK (max_jobs BETWEEN 0 AND 16),
  ADD COLUMN capabilities text[]  NOT NULL DEFAULT '{}';

CREATE TABLE infra.worker_jobs (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES identity.tenants(id),
  kind                text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{1,39}$'),
  title               text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  input               jsonb NOT NULL DEFAULT '{}',
  -- queued → running → completed | failed | cancelled
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  priority            integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10 AND 10),
  -- Requirements: only this device, only these kinds of device, needs a GPU, needs free RAM.
  target_device_id    uuid REFERENCES infra.devices(id),
  target_kinds        text[] NOT NULL DEFAULT '{}',
  need_gpu            boolean NOT NULL DEFAULT false,
  min_free_ram_mb     integer NOT NULL DEFAULT 0 CHECK (min_free_ram_mb BETWEEN 0 AND 10000000),
  timeout_sec         integer NOT NULL DEFAULT 600 CHECK (timeout_sec BETWEEN 10 AND 86400),
  max_attempts        integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  attempts            integer NOT NULL DEFAULT 0,
  -- The device running it now, and devices that lost it before (not offered it again).
  device_id           uuid REFERENCES infra.devices(id),
  excluded_device_ids uuid[] NOT NULL DEFAULT '{}',
  lease_expires_at    timestamptz,
  cancel_requested    boolean NOT NULL DEFAULT false,
  progress            integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  progress_note       text CHECK (length(progress_note) <= 200),
  result              jsonb,
  error_code          text CHECK (length(error_code) <= 60),
  error_message       text CHECK (length(error_message) <= 1000),
  created_by          uuid NOT NULL REFERENCES identity.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worker_jobs_queue ON infra.worker_jobs (tenant_id, priority DESC, created_at)
  WHERE status = 'queued';
CREATE INDEX worker_jobs_running ON infra.worker_jobs (tenant_id, device_id) WHERE status = 'running';
CREATE INDEX worker_jobs_recent ON infra.worker_jobs (tenant_id, created_at DESC);

CREATE TABLE infra.worker_job_logs (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  job_id      uuid NOT NULL REFERENCES infra.worker_jobs(id),
  device_id   uuid REFERENCES infra.devices(id),
  level       text NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message     text NOT NULL CHECK (length(message) <= 1000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX worker_job_logs_job ON infra.worker_job_logs (tenant_id, job_id, created_at);

ALTER TABLE infra.worker_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE infra.worker_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_jobs_access ON infra.worker_jobs
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE infra.worker_job_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE infra.worker_job_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_job_logs_access ON infra.worker_job_logs
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT SELECT, INSERT, UPDATE ON infra.worker_jobs TO maris_app;
GRANT SELECT, INSERT ON infra.worker_job_logs TO maris_app;
