import { z } from 'zod';
import { skillFieldSchema, SKILL_MAX_INPUTS, type SkillField } from './skills';

/** Format tag of an exported connector file. */
export const CONNECTOR_FORMAT = 'maris.connector/v1';
export const CONNECTOR_MAX_CAPABILITIES = 20;
/** Longest text kept from a response: what a workflow step receives. */
export const CONNECTOR_OUTPUT_MAX_CHARS = 20_000;

export const CONNECTOR_KINDS = ['http', 'webhook'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export const CONNECTOR_KIND_LABEL: Record<ConnectorKind, string> = {
  http: 'Gọi API (REST, GraphQL)',
  webhook: 'Nhận Webhook',
};

export const CONNECTOR_STATUSES = ['draft', 'active', 'paused'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];
export const CONNECTOR_STATUS_LABEL: Record<ConnectorStatus, string> = {
  draft: 'Chưa kích hoạt',
  active: 'Đang bật',
  paused: 'Tạm tắt',
};

export const CONNECTOR_AUTH_TYPES = ['none', 'bearer', 'header', 'query', 'path'] as const;
export type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];
export const CONNECTOR_AUTH_LABEL: Record<ConnectorAuthType, string> = {
  none: 'Không cần đăng nhập',
  bearer: 'Authorization: Bearer <secret>',
  header: 'Header riêng chứa secret',
  query: 'Tham số trên địa chỉ chứa secret',
  path: 'Secret nằm trong đường dẫn ({{secret}})',
};

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Read capabilities only fetch; write capabilities send or change something outside MARIS. */
export const CAPABILITY_RISKS = ['read', 'write'] as const;
export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number];
export const CAPABILITY_RISK_LABEL: Record<CapabilityRisk, string> = {
  read: 'Chỉ đọc',
  write: 'Gửi hoặc thay đổi bên ngoài',
};

const connectorKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'mã Connector chỉ gồm chữ thường không dấu, số, - và _');
export const secretNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/, 'tên secret: chữ thường, số, . _ -');
/** Headers that the HTTP client sets itself, or that would let a connector act as someone else. */
const RESERVED_HEADERS = [
  'host',
  'content-length',
  'content-type',
  'connection',
  'transfer-encoding',
  'cookie',
  'user-agent',
  'authorization',
  'proxy-authorization',
];
const headerName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'tên header chỉ gồm chữ, số và -')
  .refine((h) => !RESERVED_HEADERS.includes(h.toLowerCase()), 'header này do MARIS tự đặt');
const noNewline = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\r\n]*$/, 'không được xuống dòng');

/** Static headers sent on every call. Keys are checked one by one so the message names the header. */
const headersSchema = z.record(z.string(), noNewline(500)).superRefine((h, ctx) => {
  for (const k of Object.keys(h)) {
    const r = headerName.safeParse(k);
    if (!r.success)
      ctx.addIssue({ code: 'custom', path: [k], message: `${k}: ${r.error.issues[0]!.message}` });
  }
  if (Object.keys(h).length > 20) ctx.addIssue({ code: 'custom', message: 'tối đa 20 header' });
});

export const connectorAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), secret: secretNameSchema }),
  z.object({ type: z.literal('header'), header: headerName, secret: secretNameSchema }),
  z.object({
    type: z.literal('query'),
    param: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'tên tham số chỉ gồm chữ, số, . _ -'),
    secret: secretNameSchema,
  }),
  z.object({ type: z.literal('path'), secret: secretNameSchema }),
]);
export type ConnectorAuth = z.output<typeof connectorAuthSchema>;

const PLACEHOLDER_RE = /\{\{\s*([a-z]+)(?:\.([a-z][a-z0-9_]*))?\s*\}\}/g;
/** Placeholders in a capability template: {{input.x}} or {{secret}}. Anything else is refused. */
export function capabilityPlaceholders(text: string): { kind: string; name: string | null }[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => ({ kind: m[1]!, name: m[2] ?? null }));
}
/** The body template with every placeholder replaced by a sample, to check it is JSON. */
export function sampleBody(body: string): string {
  return body.replace(PLACEHOLDER_RE, 'x');
}

export const connectorCapabilitySchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, 'mã thao tác chỉ gồm chữ thường không dấu, số và _'),
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(''),
    risk: z.enum(CAPABILITY_RISKS),
    method: z.enum(HTTP_METHODS),
    path: noNewline(500).refine(
      (p) =>
        p.startsWith('/') &&
        !p.includes('://') &&
        !/(^|\/)\.\.?(\/|$)/.test(p) &&
        !p.includes('?') &&
        !p.includes('#'),
      'đường dẫn bắt đầu bằng /, không có ?, #, .. hay địa chỉ đầy đủ',
    ),
    query: z
      .record(
        z.string().regex(/^[A-Za-z0-9_.\-[\]]{1,64}$/, 'tên tham số không hợp lệ'),
        noNewline(2000),
      )
      .default({}),
    /** JSON with {{input.x}} placeholders inside its strings. Values are escaped when filled in. */
    body: z.string().max(8000).nullable().default(null),
    inputs: z.array(skillFieldSchema).max(SKILL_MAX_INPUTS).default([]),
    /** Dotted path picked from a JSON response, for example result.message_id. */
    outputPath: z
      .string()
      .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, 'dạng a.b.c')
      .max(200)
      .nullable()
      .default(null),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string, path: string) =>
      ctx.addIssue({ code: 'custom', message, path: [path] });
    const names = c.inputs.map((f) => f.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) issue(`ô nhập "${dup}" bị trùng tên`, 'inputs');
    if (c.body !== null && c.method === 'GET')
      issue('yêu cầu GET không có nội dung gửi đi', 'body');
    const parts: [string, string][] = [
      ['path', c.path],
      ...Object.values(c.query).map((v): [string, string] => ['query', v]),
      ...(c.body === null ? [] : [['body', c.body] as [string, string]]),
    ];
    for (const [where, text] of parts) {
      for (const p of capabilityPlaceholders(text)) {
        if (p.kind === 'secret' && p.name === null) {
          if (where !== 'path') issue('{{secret}} chỉ được đặt trong đường dẫn', where);
        } else if (p.kind !== 'input' || p.name === null) {
          issue('chỉ dùng {{input.<tên ô>}} hoặc {{secret}}', where);
        } else if (!names.includes(p.name)) {
          issue(`dùng ô nhập chưa khai báo: ${p.name}`, where);
        }
      }
    }
    if (c.body !== null) {
      try {
        JSON.parse(sampleBody(c.body));
      } catch {
        issue('nội dung gửi đi phải là JSON; đặt {{input.x}} bên trong dấu ngoặc kép', 'body');
      }
    }
  });
export type ConnectorCapability = z.output<typeof connectorCapabilitySchema>;
export type ConnectorCapabilityInput = z.input<typeof connectorCapabilitySchema>;

export const connectorWebhookSchema = z.object({
  workflowKey: z.string().max(64).nullable().default(null),
  runBudgetUsd: z.number().positive().max(5).default(0.5),
});
export type ConnectorWebhook = z.output<typeof connectorWebhookSchema>;

const connectorBody = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  baseUrl: z.string().trim().url('địa chỉ không hợp lệ').max(500).nullable().default(null),
  auth: connectorAuthSchema.default({ type: 'none' }),
  headers: headersSchema.default({}),
  timeoutSec: z.number().int().min(1).max(60).default(15),
  capabilities: z.array(connectorCapabilitySchema).max(CONNECTOR_MAX_CAPABILITIES).default([]),
  webhook: connectorWebhookSchema.nullable().default(null),
};

type Shape = {
  kind?: ConnectorKind;
  baseUrl?: string | null;
  auth?: ConnectorAuth;
  capabilities?: ConnectorCapability[];
  webhook?: ConnectorWebhook | null;
};
/** Checks that need the whole connector: kind-specific fields, unique keys, {{secret}} placement. */
export function checkConnector(v: Shape, ctx: z.RefinementCtx): void {
  const issue = (message: string, path: string) =>
    ctx.addIssue({ code: 'custom', message, path: [path] });
  if (v.kind === 'http') {
    if (!v.baseUrl) issue('cần địa chỉ API', 'baseUrl');
    if (v.capabilities && !v.capabilities.length) issue('cần ít nhất một thao tác', 'capabilities');
    if (v.webhook) issue('chỉ Connector nhận Webhook mới có phần Webhook', 'webhook');
  }
  if (v.kind === 'webhook') {
    if (v.baseUrl) issue('Connector nhận Webhook không gọi ra ngoài', 'baseUrl');
    if (v.capabilities?.length) issue('Connector nhận Webhook không có thao tác', 'capabilities');
    if (v.auth && v.auth.type !== 'none')
      issue('Connector nhận Webhook dùng mã bí mật riêng', 'auth');
  }
  if (v.baseUrl) {
    try {
      const u = new URL(v.baseUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') issue('chỉ hỗ trợ http(s)', 'baseUrl');
      if (u.username || u.password) issue('địa chỉ không được chứa tài khoản', 'baseUrl');
      if (u.search || u.hash) issue('địa chỉ gốc không có ? hay #', 'baseUrl');
    } catch {
      /* reported by the url check */
    }
  }
  if (v.capabilities) {
    const keys = v.capabilities.map((c) => c.key);
    const dup = keys.find((k, i) => keys.indexOf(k) !== i);
    if (dup) issue(`mã thao tác "${dup}" bị trùng`, 'capabilities');
    if (v.auth) {
      const usesSecret = v.capabilities.map((c) =>
        capabilityPlaceholders(c.path).some((p) => p.kind === 'secret'),
      );
      if (v.auth.type === 'path' && usesSecret.some((u) => !u))
        issue('mọi thao tác phải có {{secret}} trong đường dẫn', 'capabilities');
      if (v.auth.type !== 'path' && usesSecret.some((u) => u))
        issue('{{secret}} chỉ dùng khi chọn "Secret nằm trong đường dẫn"', 'capabilities');
    }
  }
}

export const createConnectorSchema = z
  .object({ key: connectorKey, kind: z.enum(CONNECTOR_KINDS), ...connectorBody })
  .superRefine(checkConnector);
export type CreateConnector = z.input<typeof createConnectorSchema>;

/** Status changes go through activate and pause, so an edit never turns a connector on. */
export const updateConnectorSchema = z
  .object({
    name: connectorBody.name,
    description: z.string().trim().max(500),
    baseUrl: z.string().trim().url('địa chỉ không hợp lệ').max(500).nullable(),
    auth: connectorAuthSchema,
    headers: headersSchema,
    timeoutSec: z.number().int().min(1).max(60),
    capabilities: z.array(connectorCapabilitySchema).max(CONNECTOR_MAX_CAPABILITIES),
    webhook: connectorWebhookSchema.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'không có gì để cập nhật');
export type UpdateConnector = z.input<typeof updateConnectorSchema>;

export const callConnectorSchema = z.object({
  capability: z.string().max(40),
  inputs: z.record(z.string(), z.union([z.string().max(8000), z.number()])).default({}),
});
export type CallConnector = z.input<typeof callConnectorSchema>;

/** The exported file: no secret values, only the names of the secrets it needs. */
export const connectorManifestSchema = z
  .object({
    format: z.literal(CONNECTOR_FORMAT),
    key: connectorKey,
    kind: z.enum(CONNECTOR_KINDS),
    ...connectorBody,
    checksum: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine(checkConnector);
export type ConnectorManifest = z.output<typeof connectorManifestSchema>;

export const importConnectorSchema = z.object({
  manifest: z.unknown(),
  replace: z.boolean().default(false),
});
export type ImportConnector = z.input<typeof importConnectorSchema>;

export interface ConnectorResponse {
  id: string;
  key: string;
  name: string;
  description: string;
  kind: ConnectorKind;
  source: 'template' | 'created' | 'imported';
  status: ConnectorStatus;
  baseUrl: string | null;
  auth: ConnectorAuth;
  headers: Record<string, string>;
  timeoutSec: number;
  capabilities: ConnectorCapability[];
  webhook: (ConnectorWebhook & { path: string; hasToken: boolean }) | null;
  /** Secret names the connector needs that are not in the Secret Vault. */
  missingSecrets: string[];
  activatedBy: string | null;
  activatedAt: string | null;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

/** Returned once, when a webhook token is made. Only its hash is stored. */
export interface ConnectorTokenResponse {
  connector: ConnectorResponse;
  token: string;
}

export interface ConnectorCallResponse {
  id: string;
  connectorId: string;
  capability: string;
  risk: CapabilityRisk;
  status: 'pending' | 'ok' | 'failed';
  request: string;
  httpStatus: number | null;
  durationMs: number | null;
  output: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  workflowRunId: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface WebhookEventResponse {
  id: string;
  connectorId: string;
  status: 'accepted' | 'rejected' | 'started';
  detail: string;
  bodyExcerpt: string;
  workflowRunId: string | null;
  receivedAt: string;
}

export interface ConnectorTemplate {
  key: string;
  kind: ConnectorKind;
  name: string;
  description: string;
  baseUrl: string | null;
  auth: ConnectorAuth;
  headers: Record<string, string>;
  capabilities: ConnectorCapabilityInput[];
  webhook: ConnectorWebhook | null;
  /** What the person has to do before activating it. */
  setup: string;
}

const field = (name: string, label: string, type: SkillField['type'] = 'text'): SkillField => ({
  name,
  label,
  type,
  required: true,
});

/** Starter connectors. They install as drafts: nothing calls out until someone activates them. */
export const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    key: 'telegram-bot',
    kind: 'http',
    name: 'Telegram Bot',
    description: 'Gửi tin nhắn Telegram qua bot của bạn.',
    baseUrl: 'https://api.telegram.org',
    auth: { type: 'path', secret: 'telegram.bot_token' },
    headers: {},
    capabilities: [
      {
        key: 'kiem_tra_bot',
        label: 'Kiểm tra bot',
        description: 'Hỏi Telegram tên của bot, để biết token đúng.',
        risk: 'read',
        method: 'GET',
        path: '/bot{{secret}}/getMe',
        outputPath: 'result.username',
      },
      {
        key: 'gui_tin_nhan',
        label: 'Gửi tin nhắn',
        description: 'Gửi một tin nhắn tới một cuộc trò chuyện hoặc nhóm.',
        risk: 'write',
        method: 'POST',
        path: '/bot{{secret}}/sendMessage',
        body: '{"chat_id": "{{input.chat_id}}", "text": "{{input.noi_dung}}"}',
        inputs: [
          field('chat_id', 'Mã cuộc trò chuyện (chat_id)'),
          field('noi_dung', 'Nội dung', 'long_text'),
        ],
        outputPath: 'result.message_id',
      },
    ],
    webhook: null,
    setup: 'Tạo bot với @BotFather, lưu token vào Secret Vault với tên telegram.bot_token.',
  },
  {
    key: 'github',
    kind: 'http',
    name: 'GitHub',
    description: 'Xem và tạo issue trong kho mã GitHub.',
    baseUrl: 'https://api.github.com',
    auth: { type: 'bearer', secret: 'github.token' },
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    capabilities: [
      {
        key: 'danh_sach_issue',
        label: 'Xem issue đang mở',
        risk: 'read',
        method: 'GET',
        path: '/repos/{{input.chu_so_huu}}/{{input.kho}}/issues',
        query: { state: 'open', per_page: '10' },
        inputs: [field('chu_so_huu', 'Chủ sở hữu'), field('kho', 'Tên kho')],
      },
      {
        key: 'tao_issue',
        label: 'Tạo issue',
        risk: 'write',
        method: 'POST',
        path: '/repos/{{input.chu_so_huu}}/{{input.kho}}/issues',
        body: '{"title": "{{input.tieu_de}}", "body": "{{input.noi_dung}}"}',
        inputs: [
          field('chu_so_huu', 'Chủ sở hữu'),
          field('kho', 'Tên kho'),
          field('tieu_de', 'Tiêu đề'),
          field('noi_dung', 'Nội dung', 'long_text'),
        ],
        outputPath: 'html_url',
      },
    ],
    webhook: null,
    setup:
      'Tạo fine-grained token trên GitHub (chỉ quyền Issues), lưu vào Secret Vault với tên github.token.',
  },
  {
    key: 'n8n',
    kind: 'http',
    name: 'n8n',
    description: 'Gửi dữ liệu sang một Webhook của n8n (hoặc Make) để chạy tiếp ở đó.',
    baseUrl: 'https://n8n.example.com',
    auth: { type: 'header', header: 'X-Maris-Key', secret: 'n8n.webhook_key' },
    headers: {},
    capabilities: [
      {
        key: 'gui_du_lieu',
        label: 'Gửi dữ liệu',
        risk: 'write',
        method: 'POST',
        path: '/webhook/{{input.duong_dan}}',
        body: '{"noi_dung": "{{input.noi_dung}}"}',
        inputs: [
          field('duong_dan', 'Đường dẫn Webhook'),
          field('noi_dung', 'Nội dung', 'long_text'),
        ],
      },
    ],
    webhook: null,
    setup:
      'Sửa địa chỉ API thành địa chỉ n8n của bạn. Trong n8n, bật Header Auth tên X-Maris-Key và lưu cùng giá trị vào Secret Vault với tên n8n.webhook_key.',
  },
  {
    key: 'nhan-danh-gia',
    kind: 'webhook',
    name: 'Nhận đánh giá từ bên ngoài',
    description:
      'n8n, Make hoặc website gửi một đánh giá vào; MARIS chạy Workflow "Xử lý đánh giá của khách".',
    baseUrl: null,
    auth: { type: 'none' },
    headers: {},
    capabilities: [],
    webhook: { workflowKey: 'xu-ly-danh-gia', runBudgetUsd: 0.5 },
    setup:
      'Tạo mã bí mật, rồi cho bên gửi gọi POST tới địa chỉ Webhook với header X-Maris-Token và nội dung JSON {"danh_gia": "..."}.',
  },
];
