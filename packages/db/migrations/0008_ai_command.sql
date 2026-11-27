-- Sprint 8 (Phase 3): AI Central Command (spec Part 06). Access levels for agents and tasks,
-- and plans: a business goal that MARIS breaks into steps assigned to agents.

-- ---------- access levels ----------
-- READ < ANALYZE < PLAN < PREPARE < EXECUTE < CONTROL < DEVELOP < DEPLOY. Only a person with
-- ai.manage sets an agent's level; nothing an AI writes can change it. In Phase 3 a task only
-- produces text, so tasks may require at most PREPARE.
ALTER TABLE ai.agents ADD COLUMN access_level text NOT NULL DEFAULT 'prepare'
  CHECK (access_level IN ('read', 'analyze', 'plan', 'prepare', 'execute', 'control', 'develop', 'deploy'));

-- ---------- plans ----------
CREATE TABLE ai.plans (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  created_by     uuid NOT NULL REFERENCES identity.users(id),
  goal           text NOT NULL CHECK (length(goal) BETWEEN 1 AND 4000),
  project_id     uuid REFERENCES ai.projects(id),
  budget_usd     numeric(12, 4) NOT NULL CHECK (budget_usd > 0 AND budget_usd <= 1000),
  status         text NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning', 'proposed', 'accepted', 'discarded', 'failed')),
  summary        text,
  -- Proposed steps, validated by the API: [{title, goal, scope, successCriteria, agentId, requiredLevel, budgetUsd, note}]
  steps          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 8),
  report_status  text CHECK (report_status IN ('running', 'completed', 'failed')),
  report         text,
  cost_usd       numeric(14, 6) NOT NULL DEFAULT 0,
  error_code     text,
  accepted_by    uuid REFERENCES identity.users(id),
  accepted_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plans_tenant ON ai.plans (tenant_id, created_at DESC);

ALTER TABLE ai.tasks ADD COLUMN plan_id uuid REFERENCES ai.plans(id);
ALTER TABLE ai.tasks ADD COLUMN step_index integer CHECK (step_index BETWEEN 0 AND 7);
ALTER TABLE ai.tasks ADD COLUMN required_level text NOT NULL DEFAULT 'prepare'
  CHECK (required_level IN ('read', 'analyze', 'plan', 'prepare'));
CREATE UNIQUE INDEX tasks_plan_step ON ai.tasks (plan_id, step_index) WHERE plan_id IS NOT NULL;

ALTER TABLE ai.provider_calls ADD COLUMN plan_id uuid REFERENCES ai.plans(id);

-- ---------- RLS ----------
ALTER TABLE ai.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.plans FORCE ROW LEVEL SECURITY;
CREATE POLICY plans_access ON ai.plans
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT SELECT, INSERT, UPDATE ON ai.plans TO maris_app;
