import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  real,
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
  planId: uuid('plan_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type AiAccessLevel = 'read' | 'analyze' | 'plan' | 'prepare' | 'execute' | 'control' | 'develop' | 'deploy';

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
  accessLevel: text('access_level').$type<AiAccessLevel>().notNull().default('prepare'),
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
  planId: uuid('plan_id'),
  stepIndex: integer('step_index'),
  requiredLevel: text('required_level').$type<AiAccessLevel>().notNull().default('prepare'),
  skillId: uuid('skill_id'),
  skillVersion: text('skill_version'),
  skillPrompt: text('skill_prompt'),
  timeoutSec: integer('timeout_sec'),
  workflowRunId: uuid('workflow_run_id'),
  workflowNodeId: text('workflow_node_id'),
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

export type AiPlanStatus = 'planning' | 'proposed' | 'accepted' | 'discarded' | 'failed';
export interface AiPlanStep {
  title: string;
  goal: string;
  scope: string;
  successCriteria: string;
  agentId: string | null;
  requiredLevel: AiAccessLevel;
  budgetUsd: number;
  note: string | null;
}

export const aiPlans = ai.table('plans', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  goal: text('goal').notNull(),
  projectId: uuid('project_id'),
  budgetUsd: numeric('budget_usd', { precision: 12, scale: 4 }).notNull(),
  status: text('status').$type<AiPlanStatus>().notNull().default('planning'),
  summary: text('summary'),
  steps: jsonb('steps').$type<AiPlanStep[]>().notNull().default([]),
  reportStatus: text('report_status').$type<'running' | 'completed' | 'failed'>(),
  report: text('report'),
  costUsd: numeric('cost_usd', { precision: 14, scale: 6 }).notNull().default('0'),
  errorCode: text('error_code'),
  acceptedBy: uuid('accepted_by'),
  acceptedAt: ts('accepted_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export interface AiSkillField {
  name: string;
  label: string;
  type: 'text' | 'long_text' | 'number' | 'choice';
  required: boolean;
  options?: string[];
  maxLength?: number;
}
export interface AiSkillManifestData {
  inputs: AiSkillField[];
  output: { format: 'markdown' };
  permissions: string[];
  dependencies: string[];
  compatibility: { maris: string };
  examples: { inputs: Record<string, string | number> }[];
}

export const aiSkills = ai.table('skills', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  description: text('description').notNull(),
  author: text('author').notNull(),
  source: text('source').$type<'template' | 'created' | 'imported'>().notNull(),
  manifest: jsonb('manifest').$type<AiSkillManifestData>().notNull(),
  instructions: text('instructions').notNull(),
  successCriteria: text('success_criteria').notNull(),
  requiredLevel: text('required_level').$type<AiAccessLevel>().notNull().default('prepare'),
  budgetUsd: numeric('budget_usd', { precision: 12, scale: 4 }).notNull(),
  timeoutSec: integer('timeout_sec').notNull().default(120),
  checksum: text('checksum').notNull(),
  status: text('status').$type<'active' | 'paused'>().notNull().default('active'),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

/** The workflow graph as stored; its shape is validated by the API (contracts `workflowGraphSchema`). */
export interface WorkGraphData {
  maxSteps: number;
  nodes: ({ id: string; type: string; label: string; next?: string | null } & Record<string, unknown>)[];
}
export type WorkflowRunStatus = 'running' | 'waiting_approval' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type WorkflowWait =
  | { kind: 'task'; taskId: string }
  | { kind: 'approval' }
  | { kind: 'delay'; until: string }
  | { kind: 'connector'; callId: string };

export const workflowDefinitions = work.table('workflow_definitions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  source: text('source').$type<'template' | 'created' | 'imported' | 'copied'>().notNull(),
  status: text('status').$type<'active' | 'paused'>().notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const workflowVersions = work.table('workflow_versions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  version: integer('version').notNull(),
  graph: jsonb('graph').$type<WorkGraphData>().notNull(),
  checksum: text('checksum').notNull(),
  note: text('note'),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const workflowRuns = work.table('workflow_runs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  version: integer('version').notNull(),
  status: text('status').$type<WorkflowRunStatus>().notNull(),
  input: jsonb('input').$type<Record<string, string | number>>().notNull(),
  outputs: jsonb('outputs').$type<Record<string, string>>().notNull().default({}),
  currentNode: text('current_node'),
  wait: jsonb('wait').$type<WorkflowWait | null>(),
  checkpoint: jsonb('checkpoint').$type<{ nodeId: string | null; outputs: Record<string, string> } | null>(),
  stepsTaken: integer('steps_taken').notNull().default(0),
  budgetUsd: numeric('budget_usd', { precision: 12, scale: 4 }).notNull(),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  startedBy: uuid('started_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const workflowRunSteps = work.table('workflow_run_steps', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  runId: uuid('run_id').notNull(),
  seq: integer('seq').notNull(),
  nodeId: text('node_id').notNull(),
  nodeType: text('node_type').notNull(),
  label: text('label').notNull(),
  status: text('status').$type<'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'>().notNull(),
  input: text('input'),
  output: text('output'),
  taskId: uuid('task_id'),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  startedAt: ts('started_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const integration = pgSchema('integration');

/** Stored connector parts; their shape is validated by the API (contracts `connectors.ts`). */
export type ConnectorAuthData =
  | { type: 'none' }
  | { type: 'bearer'; secret: string }
  | { type: 'header'; header: string; secret: string }
  | { type: 'query'; param: string; secret: string }
  | { type: 'path'; secret: string };
export interface ConnectorCapabilityData {
  key: string;
  label: string;
  description: string;
  risk: 'read' | 'write';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query: Record<string, string>;
  body: string | null;
  inputs: AiSkillManifestData['inputs'];
  outputPath: string | null;
}
export interface ConnectorWebhookData {
  workflowKey: string | null;
  runBudgetUsd: number;
}

export const connectors = integration.table('connectors', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  kind: text('kind').$type<'http' | 'webhook'>().notNull(),
  source: text('source').$type<'template' | 'created' | 'imported'>().notNull(),
  status: text('status').$type<'draft' | 'active' | 'paused'>().notNull().default('draft'),
  baseUrl: text('base_url'),
  auth: jsonb('auth').$type<ConnectorAuthData>().notNull(),
  headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
  timeoutSec: integer('timeout_sec').notNull().default(15),
  capabilities: jsonb('capabilities').$type<ConnectorCapabilityData[]>().notNull().default([]),
  webhook: jsonb('webhook').$type<ConnectorWebhookData | null>(),
  webhookTokenHash: text('webhook_token_hash'),
  checksum: text('checksum').notNull(),
  activatedBy: uuid('activated_by'),
  activatedAt: ts('activated_at'),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const connectorCalls = integration.table('connector_calls', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  connectorId: uuid('connector_id').notNull(),
  capability: text('capability').notNull(),
  risk: text('risk').$type<'read' | 'write'>().notNull(),
  status: text('status').$type<'pending' | 'ok' | 'failed'>().notNull().default('pending'),
  request: text('request').notNull(),
  httpStatus: integer('http_status'),
  durationMs: integer('duration_ms'),
  output: text('output'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  workflowRunId: uuid('workflow_run_id'),
  calledBy: uuid('called_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  finishedAt: ts('finished_at'),
});

export const webhookEvents = integration.table('webhook_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  connectorId: uuid('connector_id').notNull(),
  status: text('status').$type<'accepted' | 'rejected' | 'started'>().notNull(),
  detail: text('detail').notNull(),
  bodyExcerpt: text('body_excerpt').notNull().default(''),
  workflowRunId: uuid('workflow_run_id'),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

export const ext = pgSchema('ext');

export type PluginSignatureStatus = 'trusted' | 'untrusted' | 'unsigned';
export type PluginComponentKind = 'skill' | 'connector' | 'workflow';

/** The installed manifest; its shape is validated by the API (contracts `plugins.ts`). */
export const plugins = ext.table('plugins', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  version: text('version').notNull(),
  description: text('description').notNull().default(''),
  author: text('author').notNull(),
  status: text('status')
    .$type<'installed' | 'active' | 'paused' | 'revoked'>()
    .notNull()
    .default('installed'),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  checksum: text('checksum').notNull(),
  signatureStatus: text('signature_status').$type<PluginSignatureStatus>().notNull(),
  signerKeyId: text('signer_key_id'),
  installedBy: uuid('installed_by').notNull(),
  activatedBy: uuid('activated_by'),
  activatedAt: ts('activated_at'),
  revokedReason: text('revoked_reason'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const pluginVersions = ext.table('plugin_versions', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  pluginId: uuid('plugin_id').notNull(),
  version: text('version').notNull(),
  manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  checksum: text('checksum').notNull(),
  signatureStatus: text('signature_status').$type<PluginSignatureStatus>().notNull(),
  installedBy: uuid('installed_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const pluginComponents = ext.table('plugin_components', {
  tenantId: uuid('tenant_id').notNull(),
  pluginId: uuid('plugin_id').notNull(),
  kind: text('kind').$type<PluginComponentKind>().notNull(),
  key: text('key').notNull(),
  componentId: uuid('component_id').notNull(),
});

export const trustedPublishers = ext.table('trusted_publishers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  keyId: text('key_id').notNull(),
  name: text('name').notNull(),
  publicKey: text('public_key').notNull(),
  addedBy: uuid('added_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  revokedAt: ts('revoked_at'),
});

export const infra = pgSchema('infra');

export type DeviceKind =
  | 'server'
  | 'admin_pc'
  | 'staff_pc'
  | 'gpu_worker'
  | 'media_worker'
  | 'local_ai_worker'
  | 'code_runner';
export interface DeviceInfoData {
  hostname?: string;
  os?: string;
  arch?: string;
  cpuModel?: string;
  cpuCores?: number;
  ramTotalMb?: number;
  gpus?: { name: string; memTotalMb: number | null }[];
  agentVersion?: string;
}
export interface GpuSampleData {
  index: number;
  name: string;
  utilPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  tempC: number | null;
}

export const devices = infra.table('devices', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  kind: text('kind').$type<DeviceKind>().notNull(),
  status: text('status').$type<'pending' | 'active' | 'paused' | 'revoked'>().notNull().default('pending'),
  pairingHash: text('pairing_hash'),
  pairingExpiresAt: ts('pairing_expires_at'),
  tokenHash: text('token_hash'),
  info: jsonb('info').$type<DeviceInfoData>().notNull().default({}),
  lastSeenAt: ts('last_seen_at'),
  lastIp: text('last_ip'),
  pairedAt: ts('paired_at'),
  maxJobs: integer('max_jobs').notNull().default(1),
  capabilities: text('capabilities').array().notNull().default([]),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const deviceMetrics = infra.table('device_metrics', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  cpuPct: real('cpu_pct'),
  ramUsedMb: integer('ram_used_mb'),
  ramTotalMb: integer('ram_total_mb'),
  diskUsedGb: real('disk_used_gb'),
  diskTotalGb: real('disk_total_gb'),
  gpus: jsonb('gpus').$type<GpuSampleData[]>().notNull().default([]),
  cpuTempC: real('cpu_temp_c'),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
});

export const deviceEvents = infra.table('device_events', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  level: text('level').$type<'info' | 'warning' | 'error'>().notNull(),
  kind: text('kind').notNull(),
  message: text('message').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export type WorkerJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export const workerJobs = infra.table('worker_jobs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').$type<WorkerJobStatus>().notNull().default('queued'),
  priority: integer('priority').notNull().default(0),
  targetDeviceId: uuid('target_device_id'),
  targetKinds: text('target_kinds').array().$type<DeviceKind[]>().notNull().default([]),
  needGpu: boolean('need_gpu').notNull().default(false),
  minFreeRamMb: integer('min_free_ram_mb').notNull().default(0),
  timeoutSec: integer('timeout_sec').notNull().default(600),
  maxAttempts: integer('max_attempts').notNull().default(3),
  attempts: integer('attempts').notNull().default(0),
  deviceId: uuid('device_id'),
  excludedDeviceIds: uuid('excluded_device_ids').array().notNull().default([]),
  leaseExpiresAt: ts('lease_expires_at'),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  progress: integer('progress').notNull().default(0),
  progressNote: text('progress_note'),
  result: jsonb('result').$type<unknown>(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdBy: uuid('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const workerJobLogs = infra.table('worker_job_logs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  jobId: uuid('job_id').notNull(),
  deviceId: uuid('device_id'),
  level: text('level').$type<'info' | 'warning' | 'error'>().notNull(),
  message: text('message').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
