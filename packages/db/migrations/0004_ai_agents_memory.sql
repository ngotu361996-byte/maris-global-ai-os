-- Sprint 4 (Phase 3): AI Agents, chat modes, projects and project memory.

-- ---------- permissions ----------
INSERT INTO identity.permissions (key, description) VALUES
  ('ai.memory', 'Tạo dự án AI, thêm và sửa bộ nhớ dự án');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, 'ai.memory'
FROM identity.roles r
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager')
ON CONFLICT DO NOTHING;

-- ---------- agents ----------
-- An agent is configuration only: a role, a prompt and an optional provider/model.
-- Every change bumps `version` and keeps the old configuration in ai.agent_versions.
CREATE TABLE ai.agents (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES identity.tenants(id),
  key            text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  role           text NOT NULL CHECK (length(role) BETWEEN 1 AND 300),
  system_prompt  text NOT NULL CHECK (length(system_prompt) BETWEEN 1 AND 8000),
  eval_criteria  text CHECK (length(eval_criteria) <= 2000),
  provider_id    uuid REFERENCES ai.providers(id),
  model          text CHECK (length(model) BETWEEN 1 AND 200),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  template_key   text,
  version        integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by     uuid NOT NULL REFERENCES identity.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX agents_key_live ON ai.agents (tenant_id, key) WHERE deleted_at IS NULL;

CREATE TABLE ai.agent_versions (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  agent_id    uuid NOT NULL REFERENCES ai.agents(id),
  version     integer NOT NULL,
  config      jsonb NOT NULL,
  created_by  uuid NOT NULL REFERENCES identity.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);

-- ---------- projects and memory ----------
-- Projects are shared inside the tenant. Memory is stored by MARIS, independent of any AI provider,
-- and is added to the prompt of conversations attached to the project.
CREATE TABLE ai.projects (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description  text CHECK (length(description) <= 2000),
  created_by   uuid NOT NULL REFERENCES identity.users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX projects_name_live ON ai.projects (tenant_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE ai.memories (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES identity.tenants(id),
  project_id  uuid NOT NULL REFERENCES ai.projects(id),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content     text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  pinned      boolean NOT NULL DEFAULT false,
  created_by  uuid NOT NULL REFERENCES identity.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX memories_project ON ai.memories (project_id, pinned DESC, updated_at DESC) WHERE deleted_at IS NULL;

-- ---------- conversations ----------
ALTER TABLE ai.conversations
  ADD COLUMN agent_id   uuid REFERENCES ai.agents(id),
  ADD COLUMN project_id uuid REFERENCES ai.projects(id),
  ADD COLUMN mode       text NOT NULL DEFAULT 'chat'
    CHECK (mode IN ('chat', 'research', 'command', 'expert', 'coding', 'monitor', 'software'));

-- ---------- RLS ----------
ALTER TABLE ai.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.agents FORCE ROW LEVEL SECURITY;
CREATE POLICY agents_access ON ai.agents
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ai.agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.agent_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_versions_access ON ai.agent_versions
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ai.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_access ON ai.projects
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE ai.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.memories FORCE ROW LEVEL SECURITY;
CREATE POLICY memories_access ON ai.memories
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- ---------- grants ----------
-- Versions are an append-only history.
GRANT SELECT, INSERT, UPDATE ON ai.agents, ai.projects, ai.memories TO maris_app;
GRANT SELECT, INSERT ON ai.agent_versions TO maris_app;
