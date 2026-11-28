-- Sprint 23 (Phase 7): one inbox for Facebook and Instagram comments, Messenger and Instagram
-- messages (spec Parts 14, 15 and 20). Meta tells MARIS about new comments and messages through
-- a webhook (Webhook First); where Meta cannot reach MARIS (a computer without a public address),
-- a poller reads the latest ones in turn, a few Pages at a time (app.system = 'meta_inbox').
-- Every message is stored once (its Meta id is unique per tenant), so the webhook, the poller
-- and MARIS's own replies coming back as echoes never make doubles.
-- Replies go out as the Page, at most 400 a day per tenant (BUSINESS plan), and Messenger or
-- Instagram messages only within 24 hours of the customer's last message.

INSERT INTO identity.permissions (key, description) VALUES
  ('inbox.read', 'Xem hộp thư bình luận và tin nhắn Facebook, Instagram'),
  ('inbox.reply', 'Trả lời bình luận và tin nhắn, dùng AI gợi ý, phân công và đóng hội thoại');

INSERT INTO identity.role_permissions (tenant_id, role_id, permission_key)
SELECT r.tenant_id, r.id, p.key
FROM identity.roles r
CROSS JOIN (VALUES ('inbox.read'), ('inbox.reply')) AS p(key)
WHERE r.builtin AND r.key IN ('owner', 'administrator', 'manager', 'member')
ON CONFLICT DO NOTHING;

-- The webhook of the tenant's Meta App: the token Meta echoes back when the callback is set up,
-- and when the last event arrived (the poller stays quiet while the webhook works).
ALTER TABLE meta.apps
  ADD COLUMN webhook_verify_token text CHECK (webhook_verify_token ~ '^[A-Za-z0-9_-]{20,64}$'),
  ADD COLUMN webhook_last_at timestamptz;

-- When the poller last read each Page or Instagram account.
ALTER TABLE meta.assets ADD COLUMN inbox_synced_at timestamptz;

-- One conversation: a customer's Messenger or Instagram chat with a Page, or one top-level comment
-- with its replies.
CREATE TABLE meta.threads (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES identity.tenants(id),
  asset_id         uuid NOT NULL REFERENCES meta.assets(id),
  channel          text NOT NULL CHECK (channel IN ('messenger', 'ig_dm', 'fb_comment', 'ig_comment')),
  -- The customer's id for chats; the top-level comment's id for comments.
  thread_key       text NOT NULL CHECK (length(thread_key) BETWEEN 1 AND 100),
  customer_id      text NOT NULL CHECK (length(customer_id) BETWEEN 1 AND 100),
  customer_name    text CHECK (length(customer_name) <= 200),
  -- For comments: the post or media it is on.
  post_id          text CHECK (length(post_id) <= 100),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  assigned_to      uuid REFERENCES identity.users(id),
  unread           integer NOT NULL DEFAULT 0 CHECK (unread >= 0),
  snippet          text NOT NULL DEFAULT '' CHECK (length(snippet) <= 300),
  last_message_at  timestamptz NOT NULL,
  -- The customer's last message: Messenger and Instagram replies need it within 24 hours.
  last_inbound_at  timestamptz,
  -- The last AI suggestion, kept until someone sends or asks again.
  ai_suggestion    text CHECK (length(ai_suggestion) <= 4000),
  ai_handoff       boolean NOT NULL DEFAULT false,
  ai_reason        text CHECK (length(ai_reason) <= 500),
  ai_at            timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, asset_id, channel, thread_key)
);
CREATE INDEX threads_list ON meta.threads (tenant_id, status, last_message_at DESC);

CREATE TABLE meta.messages (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES identity.tenants(id),
  thread_id        uuid NOT NULL REFERENCES meta.threads(id),
  direction        text NOT NULL CHECK (direction IN ('in', 'out')),
  -- Meta's id (message mid or comment id); unknown until a reply has gone out.
  external_id      text CHECK (length(external_id) <= 200),
  -- Sent by the browser with a reply, so a double click sends once.
  client_key       uuid,
  author_name      text CHECK (length(author_name) <= 200),
  body             text NOT NULL DEFAULT '' CHECK (length(body) <= 8000),
  -- [{type, url}] from Meta; MARIS does not download them.
  attachments      jsonb NOT NULL DEFAULT '[]',
  status           text NOT NULL CHECK (status IN ('received', 'sending', 'sent', 'failed', 'unknown')),
  sent_at          timestamptz NOT NULL,
  -- Replies sent from MARIS: who, whether an AI suggestion was used, and the day they count for.
  sent_by          uuid REFERENCES identity.users(id),
  ai_assisted      boolean NOT NULL DEFAULT false,
  local_day        date,
  error_code       text CHECK (length(error_code) <= 60),
  error_message    text CHECK (length(error_message) <= 1000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (direction = 'out' OR status = 'received'),
  CHECK (sent_by IS NULL OR local_day IS NOT NULL)
);
CREATE UNIQUE INDEX messages_external ON meta.messages (tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX messages_client_key ON meta.messages (tenant_id, client_key) WHERE client_key IS NOT NULL;
CREATE INDEX messages_thread ON meta.messages (thread_id, sent_at);
CREATE INDEX messages_day ON meta.messages (tenant_id, local_day) WHERE sent_by IS NOT NULL;

-- Each webhook change once (Meta may deliver the same one again). No message text is kept here.
CREATE TABLE meta.webhook_events (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES identity.tenants(id),
  event_key    text NOT NULL CHECK (event_key ~ '^[0-9a-f]{64}$'),
  object       text NOT NULL CHECK (length(object) <= 40),
  field        text NOT NULL CHECK (length(field) <= 40),
  outcome      text NOT NULL CHECK (outcome IN ('stored', 'ignored')),
  detail       text NOT NULL DEFAULT '' CHECK (length(detail) <= 300),
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_key)
);
CREATE INDEX webhook_events_time ON meta.webhook_events (tenant_id, received_at DESC);

-- AI suggestions for a conversation are paid for like any other AI call.
ALTER TABLE ai.provider_calls ADD COLUMN meta_thread_id uuid REFERENCES meta.threads(id);

ALTER TABLE meta.threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.threads FORCE ROW LEVEL SECURITY;
CREATE POLICY threads_access ON meta.threads
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE meta.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.messages FORCE ROW LEVEL SECURITY;
CREATE POLICY messages_access ON meta.messages
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

ALTER TABLE meta.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta.webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_events_access ON meta.webhook_events
  USING (tenant_id = maris_ctx.tenant_id())
  WITH CHECK (tenant_id = maris_ctx.tenant_id());

-- The poller only needs to know which tenants have an active Facebook connection, and who made it.
CREATE POLICY connections_inbox_poller ON meta.connections FOR SELECT
  USING (current_setting('app.system', true) = 'meta_inbox');

GRANT SELECT, INSERT, UPDATE ON meta.threads TO maris_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON meta.messages TO maris_app;
GRANT SELECT, INSERT ON meta.webhook_events TO maris_app;
