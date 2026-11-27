-- Sprint 7 (Phase 3): files uploaded to MARIS (attached to chat messages).
-- The bytes live in file storage (local disk now, S3/MinIO later) under a key MARIS chooses;
-- the user's file name is never part of a path. The type is detected from the content, not
-- taken from the browser. Files are private to the person who uploaded them.
CREATE TABLE ai.files (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES identity.tenants(id),
  uploaded_by      uuid NOT NULL REFERENCES identity.users(id),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  mime             text NOT NULL CHECK (length(mime) BETWEEN 3 AND 100),
  kind             text NOT NULL CHECK (kind IN ('image', 'text', 'document', 'video', 'audio')),
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
  sha256           text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key      text NOT NULL,
  conversation_id  uuid REFERENCES ai.conversations(id),
  message_id       uuid REFERENCES ai.messages(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX files_owner ON ai.files (tenant_id, uploaded_by, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX files_message ON ai.files (message_id) WHERE message_id IS NOT NULL;

ALTER TABLE ai.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai.files FORCE ROW LEVEL SECURITY;
CREATE POLICY files_access ON ai.files
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

GRANT SELECT, INSERT, UPDATE ON ai.files TO maris_app;
