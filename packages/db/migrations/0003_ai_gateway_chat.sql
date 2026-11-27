-- Sprint 3 (Phase 3): AI Provider Gateway and AI Chat.

-- ---------- permissions ----------
INSERT INTO identity.permissions (key, description) VALUES
  ('ai.chat',   'Chat với AI, xem danh sách AI Provider đang bật'),
  ('ai.manage', 'Thêm, sửa, xóa AI Provider, đổi thứ tự dự phòng, xem chi phí AI');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('ai.chat'), ('ai.manage')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator')
ON CONFLICT DO NOTHING;

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'ai.chat'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('manager', 'member')
ON CONFLICT DO NOTHING;

CREATE SCHEMA IF NOT EXISTS ai;

-- ---------- providers ----------
-- The API key is never stored here: secret_ref points into security.secrets (secret://<id>).
CREATE TABLE ai.providers (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES identity.tenants(id),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind                  text NOT NULL CHECK (kind IN ('openai', 'anthropic', 'gemini', 'ollama', 'openai_compatible')),
  base_url              text,
  secret_ref            text CHECK (secret_ref ~ '^secret://[0-9a-f-]{36}$'),
  default_model         text NOT NULL CHECK (length(default_model) BETWEEN 1 AND 200),
  priority              integer NOT NULL DEFAULT 100,
  enabled               boolean NOT NULL DEFAULT true,
  timeout_ms            integer NOT NULL DEFAULT 60000 CHECK (timeout_ms BETWEEN 1000 AND 600000),
  input_cost_per_mtok   numeric(12, 6),
  output_cost_per_mtok  numeric(12, 6),
  created_by            uuid NOT NULL REFERENCES identity.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX providers_name_live ON ai.providers (tenant_id, lower(name)) WHERE deleted_at IS NULL;

-- ---------- conversations and messages ----------
-- Conversations are private to their author inside the tenant.
CREATE TABLE ai.conversations (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  user_id      uuid NOT NULL REFERENCES identity.users(id),
  title        text NOT NULL DEFAULT 'Cuộc trò chuyện mới' CHECK (length(title) BETWEEN 1 AND 200),
  provider_id  uuid REFERENCES ai.providers(id),
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX conversations_user_recent ON ai.conversations (tenant_id, user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE ai.messages (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES identity.tenants(id),
  user_id          uuid NOT NULL REFERENCES identity.users(id),
  conversation_id  uuid NOT NULL REFERENCES ai.conversations(id),
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming', 'complete', 'error', 'cancelled')),
  provider_id      uuid REFERENCES ai.providers(id),
  model            text,
  input_tokens     integer,
  output_tokens    integer,
  cost_usd         numeric(14, 6),
  latency_ms       integer,
  error_code       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation ON ai.messages (conversation_id, created_at);

-- One row per provider attempt (including failed ones), for the token and cost monitor.
CREATE TABLE ai.provider_calls (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  message_id     uuid REFERENCES ai.messages(id),
  provider_id    uuid NOT NULL REFERENCES ai.providers(id),
  model          text NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('ok', 'error', 'timeout', 'circuit_open', 'cancelled')),
  error_code     text,
  input_tokens   integer,
  output_tokens  integer,
  cost_usd       numeric(14, 6),
  latency_ms     integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_calls_tenant_time ON ai.provider_calls (tenant_id, created_at);

-- ---------- RLS ----------
ALTER TABLE ai.providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.providers FORCE ROW LEVEL SECURITY;
CREATE POLICY providers_access ON ai.providers
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ai.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_owner ON ai.conversations
  USING (tenant_id = maris_ctx.tenant_id() AND user_id = maris_ctx.user_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id() AND user_id = maris_ctx.user_id());

ALTER TABLE ai.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY messages_owner ON ai.messages
  USING (tenant_id = maris_ctx.tenant_id() AND user_id = maris_ctx.user_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id() AND user_id = maris_ctx.user_id());

-- Usage rows carry no message content, so anyone in the tenant context may read them;
-- the API restricts the usage report to ai.manage.
ALTER TABLE ai.provider_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.provider_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_calls_access ON ai.provider_calls
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- ---------- grants ----------
GRANT USAGE ON SCHEMA ai TO maris_app;
GRANT SELECT, INSERT, UPDATE ON ai.providers, ai.conversations, ai.messages TO maris_app;
GRANT SELECT, INSERT ON ai.provider_calls TO maris_app;
