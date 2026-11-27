-- Sprint 6 (Phase 3): Model Registry with capabilities and per-model prices, and the AI Council.

-- ---------- model registry ----------
-- Per tenant: which models each provider offers, what they are good at, and their prices.
-- The router uses capabilities to pick a model for a chat mode, and model prices win over
-- the provider's prices. A disabled model is never used by the router.
CREATE TABLE ai.models (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES identity.tenants(id),
  provider_id           uuid NOT NULL REFERENCES ai.providers(id),
  model                 text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  capabilities          text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (capabilities <@ ARRAY['chat', 'reasoning', 'coding', 'long_context', 'vision', 'fast', 'low_cost']),
  context_window        integer CHECK (context_window > 0 AND context_window <= 100000000),
  input_cost_per_mtok   numeric(12, 4) CHECK (input_cost_per_mtok >= 0),
  output_cost_per_mtok  numeric(12, 4) CHECK (output_cost_per_mtok >= 0),
  enabled               boolean NOT NULL DEFAULT true,
  created_by            uuid NOT NULL REFERENCES identity.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX models_provider_model ON ai.models (tenant_id, provider_id, model);

-- ---------- AI Council ----------
-- Several AIs answer one question independently, optionally critique each other, and one of
-- them writes a synthesis. It only produces text. Each run has a member limit, a cost cap and
-- a fixed number of stages, so it always stops.
CREATE TABLE ai.councils (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES identity.tenants(id),
  created_by    uuid NOT NULL REFERENCES identity.users(id),
  question      text NOT NULL CHECK (length(question) BETWEEN 1 AND 8000),
  members       jsonb NOT NULL CHECK (jsonb_typeof(members) = 'array' AND jsonb_array_length(members) BETWEEN 2 AND 4),
  critique      boolean NOT NULL DEFAULT true,
  max_cost_usd  numeric(12, 4) NOT NULL CHECK (max_cost_usd > 0 AND max_cost_usd <= 50),
  project_id    uuid REFERENCES ai.projects(id),
  status        text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  stage         text,
  synthesis     text,
  cost_usd      numeric(14, 6) NOT NULL DEFAULT 0,
  error_code    text,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX councils_tenant ON ai.councils (tenant_id, created_at DESC);

CREATE TABLE ai.council_turns (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES identity.tenants(id),
  council_id    uuid NOT NULL REFERENCES ai.councils(id),
  stage         text NOT NULL CHECK (stage IN ('answer', 'critique', 'synthesis')),
  member_index  integer NOT NULL CHECK (member_index BETWEEN 0 AND 3),
  provider_id   uuid REFERENCES ai.providers(id),
  model         text,
  status        text NOT NULL CHECK (status IN ('complete', 'error', 'cancelled')),
  content       text NOT NULL DEFAULT '',
  error_code    text,
  cost_usd      numeric(14, 6),
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX council_turns_council ON ai.council_turns (council_id, created_at);

ALTER TABLE ai.provider_calls ADD COLUMN council_id uuid REFERENCES ai.councils(id);

-- ---------- RLS ----------
ALTER TABLE ai.models ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.models FORCE ROW LEVEL SECURITY;
CREATE POLICY models_access ON ai.models
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ai.councils ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.councils FORCE ROW LEVEL SECURITY;
CREATE POLICY councils_access ON ai.councils
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ai.council_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.council_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY council_turns_access ON ai.council_turns
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- ---------- grants ----------
-- Council turns are an append-only record.
GRANT SELECT, INSERT, UPDATE, DELETE ON ai.models TO maris_app;
GRANT SELECT, INSERT, UPDATE ON ai.councils TO maris_app;
GRANT SELECT, INSERT ON ai.council_turns TO maris_app;
