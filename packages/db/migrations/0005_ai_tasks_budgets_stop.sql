-- Sprint 5 (Phase 3): Structured Task with approval, emergency stop, Cost Governor budgets.

-- ---------- permissions ----------
INSERT INTO identity.permissions (key, description) VALUES
  ('ai.approve', 'Phê duyệt, từ chối công việc AI; bật lại AI sau Dừng khẩn cấp');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'ai.approve'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

-- ---------- structured tasks ----------
-- A command from chat becomes a task with goal, scope, permissions, budget and success criteria.
-- Nothing runs until someone with ai.approve approves it. In Phase 3 the only permitted action is
-- producing text with an AI; external actions arrive with connectors in later phases.
CREATE TABLE ai.tasks (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES identity.tenants(id),
  created_by        uuid NOT NULL REFERENCES identity.users(id),
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  goal              text NOT NULL CHECK (length(goal) BETWEEN 1 AND 4000),
  scope             text NOT NULL CHECK (length(scope) BETWEEN 1 AND 4000),
  success_criteria  text NOT NULL CHECK (length(success_criteria) BETWEEN 1 AND 2000),
  permissions       text[] NOT NULL DEFAULT ARRAY['ai.generate_text'] CHECK (permissions <@ ARRAY['ai.generate_text']),
  budget_usd        numeric(12, 4) NOT NULL CHECK (budget_usd > 0 AND budget_usd <= 1000),
  agent_id          uuid REFERENCES ai.agents(id),
  project_id        uuid REFERENCES ai.projects(id),
  conversation_id   uuid REFERENCES ai.conversations(id),
  status            text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'rejected', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  progress          text,
  approved_by       uuid REFERENCES identity.users(id),
  approved_at       timestamptz,
  decision_note     text CHECK (length(decision_note) <= 1000),
  result            text,
  cost_usd          numeric(14, 6) NOT NULL DEFAULT 0,
  attempts          integer NOT NULL DEFAULT 0,
  error_code        text,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_tenant_status ON ai.tasks (tenant_id, status, updated_at DESC);

ALTER TABLE ai.provider_calls ADD COLUMN task_id uuid REFERENCES ai.tasks(id);

-- ---------- budgets ----------
-- Monthly USD budgets for the whole tenant (provider_id NULL) or one provider.
-- alerted_month records the month (YYYY-MM) the 80% alert was sent, so it is sent once.
CREATE TABLE ai.budgets (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  provider_id    uuid REFERENCES ai.providers(id),
  monthly_usd    numeric(12, 2) NOT NULL CHECK (monthly_usd > 0 AND monthly_usd <= 1000000),
  alerted_month  text,
  created_by     uuid NOT NULL REFERENCES identity.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX budgets_scope ON ai.budgets (tenant_id, provider_id) NULLS NOT DISTINCT;

-- ---------- emergency stop ----------
CREATE TABLE ai.controls (
  tenant_id       uuid PRIMARY KEY REFERENCES identity.tenants(id),
  emergency_stop  boolean NOT NULL DEFAULT false,
  reason          text CHECK (length(reason) <= 500),
  changed_by      uuid NOT NULL REFERENCES identity.users(id),
  changed_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- RLS ----------
ALTER TABLE ai.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tasks_access ON ai.tasks
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ai.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY budgets_access ON ai.budgets
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ai.controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.controls FORCE ROW LEVEL SECURITY;
CREATE POLICY controls_access ON ai.controls
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- ---------- grants ----------
GRANT SELECT, INSERT, UPDATE ON ai.tasks, ai.controls TO maris_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai.budgets TO maris_app;
