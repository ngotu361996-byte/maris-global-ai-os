import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors migrations/*.sql. The SQL files are the source of truth for DDL and RLS.
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const identity = pgSchema('identity');
export const security = pgSchema('security');

export const tenants = identity.table('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  deletedAt: ts('deleted_at'),
  version: integer('version').notNull().default(1),
});

export const users = identity.table('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  mfaTotpSecretEnc: text('mfa_totp_secret_enc'),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: ts('locked_until'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
  version: integer('version').notNull().default(1),
});

export const sessions = identity.table('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
});

export const permissions = identity.table('permissions', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
});

export const roles = identity.table('roles', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  builtin: boolean('builtin').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  version: integer('version').notNull().default(1),
});

export const rolePermissions = identity.table(
  'role_permissions',
  {
    tenantId: uuid('tenant_id').notNull(),
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const tenantMembers = identity.table(
  'tenant_members',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    createdBy: uuid('created_by'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId] })],
);

export const auditLogs = security.table('audit_logs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  actorUserId: uuid('actor_user_id'),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ip: text('ip'),
  createdAt: ts('created_at').notNull(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
});

export const invitations = identity.table('invitations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  email: text('email').notNull(),
  roleId: uuid('role_id').notNull(),
  tokenHash: bytea('token_hash').notNull(),
  invitedBy: uuid('invited_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  acceptedBy: uuid('accepted_by'),
  revokedAt: ts('revoked_at'),
});

export const secrets = security.table('secrets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  ciphertext: text('ciphertext').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const work = pgSchema('work');

export const outboxEvents = work.table('outbox_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: ts('created_at').notNull().defaultNow(),
  publishedAt: ts('published_at'),
  attempts: integer('attempts').notNull().default(0),
});

export const ai = pgSchema('ai');

// numeric columns come back as strings from postgres.js; the API converts them.
export const aiProviders = ai.table('providers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').$type<'openai' | 'anthropic' | 'gemini' | 'ollama' | 'openai_compatible'>().notNull(),
  baseUrl: text('base_url'),
  secretRef: text('secret_ref'),
  defaultModel: text('default_model').notNull(),
  priority: integer('priority').notNull().default(100),
  enabled: boolean('enabled').notNull().default(true),
  timeoutMs: integer('timeout_ms').notNull().default(60000),
  inputCostPerMtok: numeric('input_cost_per_mtok', { precision: 12, scale: 6 }),
  outputCostPerMtok: numeric('output_cost_per_mtok', { precision: 12, scale: 6 }),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const aiConversations = ai.table('conversations', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull(),
  providerId: uuid('provider_id'),
  model: text('model'),
  agentId: uuid('agent_id'),
  projectId: uuid('project_id'),
  mode: text('mode').$type<'chat' | 'research' | 'command' | 'expert' | 'coding' | 'monitor' | 'software'>().notNull().default('chat'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const aiMessages = ai.table('messages', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  role: text('role').$type<'user' | 'assistant'>().notNull(),
  content: text('content').notNull().default(''),
  status: text('status').$type<'streaming' | 'complete' | 'error' | 'cancelled'>().notNull().default('complete'),
  providerId: uuid('provider_id'),
  model: text('model'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: numeric('cost_usd', { precision: 14, scale: 6 }),
  latencyMs: integer('latency_ms'),
  errorCode: text('error_code'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const aiProviderCalls = ai.table('provider_calls', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  messageId: uuid('message_id'),
  providerId: uuid('provider_id').notNull(),
  model: text('model').notNull(),
  outcome: text('outcome').$type<'ok' | 'error' | 'timeout' | 'circuit_open' | 'cancelled'>().notNull(),
  errorCode: text('error_code'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: numeric('cost_usd', { precision: 14, scale: 6 }),
  latencyMs: integer('latency_ms'),
  taskId: uuid('task_id'),
  councilId: uuid('council_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const aiAgents = ai.table('agents', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  systemPrompt: text('system_prompt').notNull(),
  evalCriteria: text('eval_criteria'),
  providerId: uuid('provider_id'),
  model: text('model'),
  status: text('status').$type<'active' | 'paused'>().notNull().default('active'),
  templateKey: text('template_key'),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const aiAgentVersions = ai.table('agent_versions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  version: integer('version').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const aiProjects = ai.table('projects', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const aiMemories = ai.table('memories', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  projectId: uuid('project_id').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  pinned: boolean('pinned').notNull().default(false),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export type AiTaskStatus = 'pending' | 'rejected' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export const aiTasks = ai.table('tasks', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  title: text('title').notNull(),
  goal: text('goal').notNull(),
  scope: text('scope').notNull(),
  successCriteria: text('success_criteria').notNull(),
  permissions: text('permissions').array().notNull(),
  budgetUsd: numeric('budget_usd', { precision: 12, scale: 4 }).notNull(),
  agentId: uuid('agent_id'),
  projectId: uuid('project_id'),
  conversationId: uuid('conversation_id'),
  status: text('status').$type<AiTaskStatus>().notNull().default('pending'),
  progress: text('progress'),
  approvedBy: uuid('approved_by'),
  approvedAt: ts('approved_at'),
  decisionNote: text('decision_note'),
  result: text('result'),
  costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
  attempts: integer('attempts').notNull().default(0),
  errorCode: text('error_code'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const aiBudgets = ai.table('budgets', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  providerId: uuid('provider_id'),
  monthlyUsd: numeric('monthly_usd', { precision: 12, scale: 2 }).notNull(),
  alertedMonth: text('alerted_month'),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const aiControls = ai.table('controls', {
  tenantId: uuid('tenant_id').primaryKey(),
  emergencyStop: boolean('emergency_stop').notNull().default(false),
  reason: text('reason'),
  changedBy: uuid('changed_by').notNull(),
  changedAt: ts('changed_at').notNull().defaultNow(),
});

export const MODEL_CAPABILITY_KEYS = [
  'chat',
  'reasoning',
  'coding',
  'long_context',
  'vision',
  'fast',
  'low_cost',
] as const;

export const aiModels = ai.table('models', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  model: text('model').notNull(),
  capabilities: text('capabilities').array().notNull(),
  contextWindow: integer('context_window'),
  inputCostPerMtok: numeric('input_cost_per_mtok', { precision: 12, scale: 4 }),
  outputCostPerMtok: numeric('output_cost_per_mtok', { precision: 12, scale: 4 }),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export type AiCouncilStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface AiCouncilMember {
  providerId: string;
  model: string;
}

export const aiCouncils = ai.table('councils', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  question: text('question').notNull(),
  members: jsonb('members').$type<AiCouncilMember[]>().notNull(),
  critique: boolean('critique').notNull().default(true),
  maxCostUsd: numeric('max_cost_usd', { precision: 12, scale: 4 }).notNull(),
  projectId: uuid('project_id'),
  status: text('status').$type<AiCouncilStatus>().notNull().default('queued'),
  stage: text('stage'),
  synthesis: text('synthesis'),
  costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
  errorCode: text('error_code'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const aiCouncilTurns = ai.table('council_turns', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  councilId: uuid('council_id').notNull(),
  stage: text('stage').$type<'answer' | 'critique' | 'synthesis'>().notNull(),
  memberIndex: integer('member_index').notNull(),
  providerId: uuid('provider_id'),
  model: text('model'),
  status: text('status').$type<'complete' | 'error' | 'cancelled'>().notNull(),
  content: text('content').notNull().default(''),
  errorCode: text('error_code'),
  costUsd: numeric('cost_usd', { precision: 14, scale: 6 }),
  latencyMs: integer('latency_ms'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type AiFileKind = 'image' | 'text' | 'document' | 'video' | 'audio';

export const aiFiles = ai.table('files', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  uploadedBy: uuid('uploaded_by').notNull(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  kind: text('kind').$type<AiFileKind>().notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  storageKey: text('storage_key').notNull(),
  conversationId: uuid('conversation_id'),
  messageId: uuid('message_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});
