-- Sprint 10 (Phase 4): Workflow Studio (spec Part 22). A workflow is a graph of steps (AI, skill,
-- condition, approval, delay, checkpoint). Each save is a new immutable version; a run pins the
-- version it started with. AI steps run as ordinary tasks, approved by the person who started the run.

CREATE TABLE work.workflow_definitions (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  key          text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description  text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  source       text NOT NULL CHECK (source IN ('template', 'created', 'imported', 'copied')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by   uuid NOT NULL REFERENCES identity.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX workflow_definitions_tenant_key ON work.workflow_definitions (tenant_id, key) WHERE deleted_at IS NULL;

CREATE TABLE work.workflow_versions (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  workflow_id  uuid NOT NULL REFERENCES work.workflow_definitions(id),
  version      integer NOT NULL CHECK (version >= 1),
  -- Nodes and limits, validated by the API.
  graph        jsonb NOT NULL,
  checksum     text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  note         text CHECK (length(note) <= 200),
  created_by   uuid NOT NULL REFERENCES identity.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE work.workflow_runs (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  workflow_id    uuid NOT NULL REFERENCES work.workflow_definitions(id),
  version        integer NOT NULL,
  status         text NOT NULL CHECK (status IN ('running', 'waiting_approval', 'paused', 'completed', 'failed', 'cancelled')),
  input          jsonb NOT NULL,
  -- Outputs of finished steps, keyed by node id.
  outputs        jsonb NOT NULL DEFAULT '{}',
  current_node   text,
  -- What the run waits for at current_node: a task, an approval or a delay.
  wait           jsonb,
  -- Last checkpoint: the node to continue from and the outputs at that time.
  checkpoint     jsonb,
  steps_taken    integer NOT NULL DEFAULT 0,
  budget_usd     numeric(12, 4) NOT NULL CHECK (budget_usd > 0 AND budget_usd <= 50),
  cost_usd       numeric(12, 6) NOT NULL DEFAULT 0,
  error_code     text,
  error_message  text,
  started_by     uuid NOT NULL REFERENCES identity.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX workflow_runs_workflow ON work.workflow_runs (tenant_id, workflow_id, created_at DESC);

-- One row per step executed: the log shown to the user, with input and output.
CREATE TABLE work.workflow_run_steps (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  run_id       uuid NOT NULL REFERENCES work.workflow_runs(id),
  seq          integer NOT NULL,
  node_id      text NOT NULL,
  node_type    text NOT NULL,
  label        text NOT NULL,
  status       text NOT NULL CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  input        text CHECK (length(input) <= 40000),
  output       text CHECK (length(output) <= 100000),
  task_id      uuid REFERENCES ai.tasks(id),
  cost_usd     numeric(12, 6) NOT NULL DEFAULT 0,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  UNIQUE (run_id, seq)
);

-- A task started by a workflow step points back to its run and node.
ALTER TABLE ai.tasks ADD COLUMN workflow_run_id uuid REFERENCES work.workflow_runs(id);
ALTER TABLE ai.tasks ADD COLUMN workflow_node_id text;

ALTER TABLE work.workflow_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.workflow_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_definitions_access ON work.workflow_definitions
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE work.workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.workflow_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_versions_access ON work.workflow_versions
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE work.workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.workflow_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_runs_access ON work.workflow_runs
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE work.workflow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.workflow_run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_run_steps_access ON work.workflow_run_steps
  USING (tenant_id = maris_ctx.tenant_id()) WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT SELECT, INSERT, UPDATE ON work.workflow_definitions TO maris_app;
-- Versions are never changed after they are written.
GRANT SELECT, INSERT ON work.workflow_versions TO maris_app;
GRANT SELECT, INSERT, UPDATE ON work.workflow_runs TO maris_app;
GRANT SELECT, INSERT, UPDATE ON work.workflow_run_steps TO maris_app;
