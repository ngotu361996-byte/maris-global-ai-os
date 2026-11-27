-- Sprint 9 (Phase 4): Skills (spec Part 23). A skill is a packaged, declarative piece of AI work:
-- input fields, instructions, required access level, budget and timeout. No code runs from a
-- skill; running one creates an ordinary task that still needs approval.

CREATE TABLE ai.skills (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES identity.tenants(id),
  key               text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  version           text NOT NULL CHECK (version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  author            text NOT NULL CHECK (length(author) BETWEEN 1 AND 120),
  source            text NOT NULL CHECK (source IN ('template', 'created', 'imported')),
  -- Input fields, output, permissions, dependencies, compatibility and examples, validated by the API.
  manifest          jsonb NOT NULL,
  instructions      text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 8000),
  success_criteria  text NOT NULL CHECK (length(success_criteria) BETWEEN 1 AND 2000),
  required_level    text NOT NULL DEFAULT 'prepare' CHECK (required_level IN ('read', 'analyze', 'plan', 'prepare')),
  budget_usd        numeric(12, 4) NOT NULL CHECK (budget_usd > 0 AND budget_usd <= 50),
  timeout_sec       integer NOT NULL DEFAULT 120 CHECK (timeout_sec BETWEEN 10 AND 600),
  -- SHA-256 of the canonical manifest, checked on import. An integrity check, not an author signature.
  checksum          text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by        uuid NOT NULL REFERENCES identity.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX skills_tenant_key ON ai.skills (tenant_id, key) WHERE deleted_at IS NULL;

-- A task started from a skill keeps which skill and version, and the prompt built from its inputs.
ALTER TABLE ai.tasks ADD COLUMN skill_id uuid REFERENCES ai.skills(id);
ALTER TABLE ai.tasks ADD COLUMN skill_version text;
ALTER TABLE ai.tasks ADD COLUMN skill_prompt text CHECK (length(skill_prompt) <= 40000);
ALTER TABLE ai.tasks ADD COLUMN timeout_sec integer CHECK (timeout_sec BETWEEN 10 AND 600);

ALTER TABLE ai.skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.skills FORCE ROW LEVEL SECURITY;
CREATE POLICY skills_access ON ai.skills
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT SELECT, INSERT, UPDATE ON ai.skills TO maris_app;
