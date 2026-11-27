import { z } from 'zod';
import { connectorManifestSchema, type ConnectorManifest } from './connectors';
import { skillManifestSchema, type SkillManifest } from './skills';
import { workflowManifestSchema, type WorkflowManifest } from './workflows';

/** Format tag of a plugin file. */
export const PLUGIN_FORMAT = 'maris.plugin/v1';
/** The MARIS version plugins are checked against (`compatibility.maris`). */
export const MARIS_VERSION = '0.12.0';
/** Text that a publisher key signs: this prefix and the manifest checksum. */
export const PLUGIN_SIGNATURE_PREFIX = 'maris.plugin/v1:';

export const PLUGIN_STATUSES = ['installed', 'active', 'paused', 'revoked'] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];
export const PLUGIN_STATUS_LABEL: Record<PluginStatus, string> = {
  installed: 'Đã cài, chưa bật',
  active: 'Đang bật',
  paused: 'Tạm dừng',
  revoked: 'Đã thu hồi',
};

export const PLUGIN_SIGNATURE_STATUSES = ['trusted', 'untrusted', 'unsigned'] as const;
export type PluginSignatureStatus = (typeof PLUGIN_SIGNATURE_STATUSES)[number];
export const PLUGIN_SIGNATURE_LABEL: Record<PluginSignatureStatus, string> = {
  trusted: 'Đã ký bởi nhà phát hành tin cậy',
  untrusted: 'Đã ký bởi khóa chưa được tin cậy',
  unsigned: 'Chưa ký',
};

/**
 * What a plugin may do. A plugin must ask for every permission its parts need, and the person who
 * activates it sees this list. There is no permission to run code or reach the database: a plugin
 * holds declarations only.
 */
export const PLUGIN_PERMISSIONS = [
  'ai.generate_text',
  'connector.read',
  'connector.write',
  'webhook.receive',
  'workflow.run',
] as const;
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];
export const PLUGIN_PERMISSION_LABEL: Record<PluginPermission, string> = {
  'ai.generate_text': 'Dùng AI để soạn văn bản (tốn chi phí AI)',
  'connector.read': 'Đọc dữ liệu từ dịch vụ bên ngoài',
  'connector.write': 'Gửi hoặc thay đổi dữ liệu ở dịch vụ bên ngoài',
  'webhook.receive': 'Nhận lời gọi từ bên ngoài để khởi chạy Workflow',
  'workflow.run': 'Chạy Workflow nhiều bước',
};

export const PLUGIN_COMPONENT_KINDS = ['skill', 'connector', 'workflow'] as const;
export type PluginComponentKind = (typeof PLUGIN_COMPONENT_KINDS)[number];
export const PLUGIN_COMPONENT_LABEL: Record<PluginComponentKind, string> = {
  skill: 'Skill',
  connector: 'Connector',
  workflow: 'Workflow',
};

const pluginKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'mã Plugin chỉ gồm chữ thường không dấu, số, - và _');
const semver = z
  .string()
  .trim()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/, 'phiên bản dạng 1.0.0');
/** `*`, `1.2.3` (exactly), `>=1.2.3` or `^1.2.3` (same major version, at least this one). */
const versionRange = z
  .string()
  .trim()
  .regex(
    /^(\*|(>=|\^)?\d{1,4}\.\d{1,4}\.\d{1,4})$/,
    'khoảng phiên bản dạng *, 1.0.0, >=1.0.0 hay ^1.0.0',
  );
export const publisherKeyId = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, 'mã khóa chỉ gồm chữ thường không dấu, số, ., - và _');

export const pluginSignatureSchema = z.object({
  alg: z.literal('ed25519'),
  keyId: publisherKeyId,
  /** Base64 Ed25519 signature of PLUGIN_SIGNATURE_PREFIX + checksum. */
  value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, 'chữ ký Ed25519 dạng base64'),
});
export type PluginSignature = z.infer<typeof pluginSignatureSchema>;

export const pluginTestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('workflow'),
    name: z.string().trim().min(1).max(80),
    key: z.string().max(64),
    inputs: z.record(z.string(), z.union([z.string().max(8000), z.number()])).default({}),
  }),
  z.object({
    kind: z.literal('skill'),
    name: z.string().trim().min(1).max(80),
    key: z.string().max(64),
    inputs: z.record(z.string(), z.union([z.string().max(8000), z.number()])).default({}),
  }),
  z.object({
    kind: z.literal('connector'),
    name: z.string().trim().min(1).max(80),
    key: z.string().max(64),
    capability: z.string().max(40),
    inputs: z.record(z.string(), z.union([z.string().max(8000), z.number()])).default({}),
  }),
]);
export type PluginTest = z.infer<typeof pluginTestSchema>;

/** The permissions a set of parts needs; the manifest must ask for each of them. */
export function requiredPluginPermissions(contents: {
  skills: SkillManifest[];
  connectors: ConnectorManifest[];
  workflows: WorkflowManifest[];
}): PluginPermission[] {
  const need = new Set<PluginPermission>();
  if (contents.skills.length) need.add('ai.generate_text');
  for (const c of contents.connectors) {
    if (c.kind === 'webhook') need.add('webhook.receive');
    for (const cap of c.capabilities)
      need.add(cap.risk === 'write' ? 'connector.write' : 'connector.read');
  }
  for (const w of contents.workflows) {
    need.add('workflow.run');
    for (const n of w.graph.nodes)
      if (n.type === 'ai' || n.type === 'skill') need.add('ai.generate_text');
  }
  return PLUGIN_PERMISSIONS.filter((p) => need.has(p));
}

/**
 * A plugin file (spec Part 23): one manifest with id, version, description, author, permissions,
 * dependencies, compatibility, resource budget, timeout, signature and a test suite. The input and
 * output schemas are those of its parts: skill fields and output, workflow start fields, connector
 * capability fields. A plugin holds only declarations; nothing in it is code.
 */
export const pluginManifestSchema = z
  .object({
    format: z.literal(PLUGIN_FORMAT),
    key: pluginKey,
    name: z.string().trim().min(1).max(80),
    version: semver,
    description: z.string().trim().max(1000).default(''),
    author: z.string().trim().min(1).max(120),
    homepage: z
      .string()
      .url()
      .max(300)
      .refine((u) => u.startsWith('https://'), 'chỉ nhận địa chỉ https')
      .optional(),
    permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length),
    dependencies: z
      .array(z.object({ key: pluginKey, version: versionRange }))
      .max(10)
      .default([]),
    compatibility: z.object({ maris: versionRange }),
    resources: z.object({
      /** Most AI spend one run of any part may approve, in USD. */
      maxRunUsd: z.number().positive().max(5),
    }),
    /** Longest any part may take, in seconds. */
    timeoutSec: z.number().int().min(10).max(600),
    contents: z.object({
      skills: z.array(skillManifestSchema).max(20).default([]),
      connectors: z.array(connectorManifestSchema).max(10).default([]),
      workflows: z.array(workflowManifestSchema).max(20).default([]),
    }),
    tests: z.array(pluginTestSchema).min(1, 'Plugin phải có ít nhất một bài kiểm tra').max(30),
    checksum: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    signature: pluginSignatureSchema.optional(),
  })
  .superRefine((m, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const { skills, connectors, workflows } = m.contents;
    if (!skills.length && !connectors.length && !workflows.length)
      issue(['contents'], 'Plugin phải có ít nhất một Skill, Connector hay Workflow');
    for (const [kind, list] of [
      ['skills', skills],
      ['connectors', connectors],
      ['workflows', workflows],
    ] as const) {
      const keys = list.map((x) => x.key);
      const dup = keys.find((k, i) => keys.indexOf(k) !== i);
      if (dup) issue(['contents', kind], `mã "${dup}" bị lặp`);
    }
    const need = requiredPluginPermissions(m.contents);
    const missing = need.filter((p) => !m.permissions.includes(p));
    if (missing.length)
      issue(
        ['permissions'],
        `Plugin chưa xin quyền mà các phần bên trong cần: ${missing.join(', ')}`,
      );
    const extra = m.permissions.filter((p) => !need.includes(p));
    if (extra.length)
      issue(['permissions'], `Plugin xin quyền không dùng tới: ${extra.join(', ')}`);
    if (m.dependencies.some((d) => d.key === m.key))
      issue(['dependencies'], 'Plugin không thể phụ thuộc chính nó');
    skills.forEach((s, i) => {
      if (s.budgetUsd > m.resources.maxRunUsd)
        issue(
          ['contents', 'skills', i, 'budgetUsd'],
          `vượt ngân sách Plugin $${m.resources.maxRunUsd}`,
        );
      if (s.timeoutSec > m.timeoutSec)
        issue(
          ['contents', 'skills', i, 'timeoutSec'],
          `vượt thời gian chờ Plugin ${m.timeoutSec} giây`,
        );
    });
    connectors.forEach((c, i) => {
      if (c.timeoutSec > m.timeoutSec)
        issue(
          ['contents', 'connectors', i, 'timeoutSec'],
          `vượt thời gian chờ Plugin ${m.timeoutSec} giây`,
        );
      if (c.webhook && c.webhook.runBudgetUsd > m.resources.maxRunUsd)
        issue(
          ['contents', 'connectors', i, 'webhook'],
          `vượt ngân sách Plugin $${m.resources.maxRunUsd}`,
        );
    });
    m.tests.forEach((t, i) => {
      const list = t.kind === 'skill' ? skills : t.kind === 'connector' ? connectors : workflows;
      if (!list.some((x) => x.key === t.key))
        issue(['tests', i, 'key'], `Plugin không có ${t.kind} "${t.key}"`);
    });
    for (const w of workflows) {
      if (!m.tests.some((t) => t.kind === 'workflow' && t.key === w.key))
        issue(['tests'], `Workflow "${w.key}" chưa có bài kiểm tra`);
    }
  });
export type PluginManifest = z.output<typeof pluginManifestSchema>;
export type PluginManifestInput = z.input<typeof pluginManifestSchema>;

/** Compares two x.y.z versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Whether a version is inside a range written as *, 1.2.3, >=1.2.3 or ^1.2.3. */
export function satisfiesRange(version: string, range: string): boolean {
  if (range === '*') return true;
  if (range.startsWith('>=')) return compareVersions(version, range.slice(2)) >= 0;
  if (range.startsWith('^')) {
    const min = range.slice(1);
    return version.split('.')[0] === min.split('.')[0] && compareVersions(version, min) >= 0;
  }
  return compareVersions(version, range) === 0;
}

export const installPluginSchema = z.object({
  manifest: z.unknown(),
  /** Install over an installed plugin with the same key (an update or a rollback). */
  replace: z.boolean().default(false),
});
export type InstallPlugin = z.input<typeof installPluginSchema>;

export const activatePluginSchema = z.object({
  /** Needed to turn on a plugin that no trusted publisher signed. */
  allowUnsigned: z.boolean().default(false),
});
export type ActivatePlugin = z.input<typeof activatePluginSchema>;

export const revokePluginSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type RevokePlugin = z.input<typeof revokePluginSchema>;

export const addPublisherSchema = z.object({
  keyId: publisherKeyId,
  name: z.string().trim().min(1).max(120),
  publicKey: z
    .string()
    .trim()
    .max(1000)
    .regex(
      /^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/,
      'khóa công khai dạng PEM (-----BEGIN PUBLIC KEY-----)',
    ),
});
export type AddPublisher = z.input<typeof addPublisherSchema>;

export interface PluginTestResult {
  name: string;
  kind: PluginComponentKind;
  key: string;
  ok: boolean;
  detail: string;
}

export interface PluginCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface PluginComponentResponse {
  kind: PluginComponentKind;
  key: string;
  id: string;
  name: string;
  status: string;
}

export interface PluginResponse {
  id: string;
  key: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage: string | null;
  status: PluginStatus;
  permissions: PluginPermission[];
  dependencies: { key: string; version: string }[];
  compatibility: { maris: string };
  resources: { maxRunUsd: number };
  timeoutSec: number;
  checksum: string;
  signatureStatus: PluginSignatureStatus;
  signerKeyId: string | null;
  components: PluginComponentResponse[];
  /** What activation checks, as of now. */
  checks: PluginCheck[];
  tests: PluginTestResult[];
  activatedBy: string | null;
  activatedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginVersionResponse {
  id: string;
  version: string;
  checksum: string;
  signatureStatus: PluginSignatureStatus;
  createdAt: string;
}

export interface PublisherResponse {
  id: string;
  keyId: string;
  name: string;
  /** SHA-256 of the key, first 16 hex characters, to compare with what the publisher says. */
  fingerprint: string;
  createdAt: string;
}

export interface PluginSample {
  key: string;
  name: string;
  description: string;
  manifest: PluginManifestInput;
}

export function isPluginManifest(v: unknown): v is PluginManifestInput {
  return !!v && typeof v === 'object' && (v as { format?: unknown }).format === PLUGIN_FORMAT;
}

/** A sample plugin to try the Plugin Center with. It is unsigned on purpose. */
export const PLUGIN_SAMPLES: readonly PluginSample[] = [
  {
    key: 'cham-soc-danh-gia',
    name: 'Chăm sóc đánh giá khách hàng',
    description:
      'Một Skill soạn câu trả lời cho đánh giá của khách và một Workflow soạn rồi chờ bạn duyệt.',
    manifest: {
      format: PLUGIN_FORMAT,
      key: 'cham-soc-danh-gia',
      name: 'Chăm sóc đánh giá khách hàng',
      version: '1.0.0',
      description:
        'Soạn câu trả lời lịch sự cho đánh giá của khách hàng, rồi chờ người duyệt trước khi dùng.',
      author: 'MARIS mẫu',
      permissions: ['ai.generate_text', 'workflow.run'],
      dependencies: [],
      compatibility: { maris: '>=0.12.0' },
      resources: { maxRunUsd: 0.5 },
      timeoutSec: 120,
      contents: {
        skills: [
          {
            format: 'maris.skill/v1',
            key: 'tra-loi-danh-gia',
            version: '1.0.0',
            author: 'MARIS mẫu',
            name: 'Trả lời đánh giá',
            description: 'Soạn câu trả lời cho một đánh giá của khách hàng.',
            inputs: [
              { name: 'khach_hang', label: 'Tên khách hàng', type: 'text', required: true },
              { name: 'danh_gia', label: 'Nội dung đánh giá', type: 'long_text', required: true },
              { name: 'so_sao', label: 'Số sao (1–5)', type: 'number', required: true },
            ],
            instructions:
              'Soạn câu trả lời ngắn, lịch sự bằng tiếng Việt cho khách {{khach_hang}}, người đã đánh giá {{so_sao}} sao với nội dung: {{danh_gia}}. Cảm ơn khách. Nếu dưới 4 sao, xin lỗi và mời khách liên hệ để được hỗ trợ. Không hứa hoàn tiền hay bồi thường.',
            successCriteria: 'Dưới 80 từ, đúng tên khách, không hứa điều cửa hàng chưa cam kết.',
            requiredLevel: 'prepare',
            budgetUsd: 0.05,
            timeoutSec: 120,
            permissions: ['ai.generate_text'],
          },
        ],
        connectors: [],
        workflows: [
          {
            format: 'maris.workflow/v1',
            key: 'xu-ly-danh-gia',
            name: 'Xử lý đánh giá mới',
            description: 'Soạn câu trả lời cho đánh giá, rồi chờ bạn duyệt.',
            version: 1,
            graph: {
              maxSteps: 10,
              nodes: [
                {
                  id: 'bat_dau',
                  type: 'trigger',
                  label: 'Đánh giá mới',
                  inputs: [
                    { name: 'khach_hang', label: 'Tên khách hàng', type: 'text', required: true },
                    {
                      name: 'danh_gia',
                      label: 'Nội dung đánh giá',
                      type: 'long_text',
                      required: true,
                    },
                    { name: 'so_sao', label: 'Số sao (1–5)', type: 'number', required: true },
                  ],
                },
                {
                  id: 'soan',
                  type: 'skill',
                  label: 'Soạn câu trả lời',
                  skillKey: 'tra-loi-danh-gia',
                  inputs: {
                    khach_hang: '{{input.khach_hang}}',
                    danh_gia: '{{input.danh_gia}}',
                    so_sao: '{{input.so_sao}}',
                  },
                },
                {
                  id: 'duyet',
                  type: 'approval',
                  label: 'Duyệt câu trả lời',
                  message: 'Đọc câu trả lời cho {{input.khach_hang}} trước khi đăng.',
                  onReject: null,
                },
                { id: 'xong', type: 'end', label: 'Xong' },
              ],
            },
          },
        ],
      },
      tests: [
        {
          kind: 'skill',
          name: 'Skill nhận đủ ô nhập',
          key: 'tra-loi-danh-gia',
          inputs: { khach_hang: 'Chị Lan', danh_gia: 'Giao hàng chậm', so_sao: 3 },
        },
        {
          kind: 'workflow',
          name: 'Workflow chạy hết các bước',
          key: 'xu-ly-danh-gia',
          inputs: { khach_hang: 'Anh Minh', danh_gia: 'Sản phẩm tốt', so_sao: 5 },
        },
      ],
    },
  },
];
