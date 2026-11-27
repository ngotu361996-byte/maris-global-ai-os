-- Sprint 11 (Phase 4): Connector Hub (spec Part 24). A connector is a declared external API: a
-- base URL, how it signs in (a reference to a Secret Vault entry, never the value), static headers
-- and a capability registry. Each capability is one request with a risk (read or write) and its own
-- input fields. Connectors start as drafts and make no workflow calls until someone with ai.approve
-- activates them; changing where or how a connector calls sends it back to draft.
-- A webhook connector receives calls instead: a shared token (only its hash is stored) proves the
-- sender, and an accepted call can start a workflow on behalf of the person who activated it.

CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE integration.connectors (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES identity.tenants(id),
  key                 text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description         text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  kind                text NOT NULL CHECK (kind IN ('http', 'webhook')),
  source              text NOT NULL CHECK (source IN ('template', 'created', 'imported')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  base_url            text CHECK (length(base_url) <= 500),
  -- {type, secret, header|param}; secret is a Secret Vault name. Validated by the API.
  auth                jsonb NOT NULL DEFAULT '{"type":"none"}',
  headers             jsonb NOT NULL DEFAULT '{}',
  timeout_sec         integer NOT NULL DEFAULT 15 CHECK (timeout_sec BETWEEN 1 AND 60),
  capabilities        jsonb NOT NULL DEFAULT '[]',
  -- Webhook connectors: {workflowKey, runBudgetUsd}.
  webhook             jsonb,
  webhook_token_hash  text CHECK (webhook_token_hash ~ '^[0-9a-f]{64}$'),
  checksum            text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  activated_by        uuid REFERENCES identity.users(id),
  activated_at        timestamptz,
  created_by          uuid NOT NULL REFERENCES identity.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CHECK (kind <> 'http' OR base_url IS NOT NULL),
  CHECK (status <> 'active' OR activated_by IS NOT NULL)
);
CREATE UNIQUE INDEX connectors_tenant_key ON integration.connectors (tenant_id, key) WHERE deleted_at IS NULL;

-- One row per outgoing call: what was asked (secrets masked), what came back, who asked.
CREATE TABLE integration.connector_calls (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES identity.tenants(id),
  connector_id     uuid NOT NULL REFERENCES integration.connectors(id),
  capability       text NOT NULL CHECK (length(capability) BETWEEN 1 AND 40),
  risk             text NOT NULL CHECK (risk IN ('read', 'write')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
  request          text NOT NULL CHECK (length(request) <= 2000),
  http_status      integer,
  duration_ms      integer,
  output           text CHECK (length(output) <= 20000),
  error_code       text,
  error_message    text CHECK (length(error_message) <= 1000),
  workflow_run_id  uuid REFERENCES work.workflow_runs(id),
  called_by        uuid NOT NULL REFERENCES identity.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX connector_calls_connector ON integration.connector_calls (tenant_id, connector_id, created_at DESC);

-- One row per call received on a webhook connector, accepted or not.
CREATE TABLE integration.webhook_events (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES identity.tenants(id),
  connector_id     uuid NOT NULL REFERENCES integration.connectors(id),
  status           text NOT NULL CHECK (status IN ('accepted', 'rejected', 'started')),
  detail           text NOT NULL CHECK (length(detail) <= 500),
  body_excerpt     text NOT NULL DEFAULT '' CHECK (length(body_excerpt) <= 4000),
  workflow_run_id  uuid REFERENCES work.workflow_runs(id),
  received_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_connector ON integration.webhook_events (tenant_id, connector_id, received_at DESC);

ALTER TABLE integration.connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.connectors FORCE ROW LEVEL SECURITY;
CREATE POLICY connectors_access ON integration.connectors
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE integration.connector_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.connector_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY connector_calls_access ON integration.connector_calls
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE integration.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_events_access ON integration.webhook_events
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT USAGE ON SCHEMA integration TO maris_app;
GRANT SELECT, INSERT, UPDATE ON integration.connectors TO maris_app;
GRANT SELECT, INSERT, UPDATE ON integration.connector_calls TO maris_app;
GRANT SELECT, INSERT ON integration.webhook_events TO maris_app;
