import { z } from 'zod';
import { taskLevelSchema, type TaskLevel } from './access-levels';
import {
  skillFieldSchema,
  SKILL_INPUT_MAX_CHARS,
  SKILL_MAX_INPUTS,
  type SkillField,
} from './skills';

/** Format tag of an exported workflow file. */
export const WORKFLOW_FORMAT = 'maris.workflow/v1';
export const WORKFLOW_MAX_NODES = 30;
export const WORKFLOW_MAX_STEPS = 200;

/**
 * Step types available now (spec Part 22). A connector step calls one capability of an active
 * connector. Schedule, data, switch, parallel, merge, worker, notification and error-handler steps
 * come with later phases and the sandbox. A webhook connector can start a workflow.
 */
export const WORKFLOW_NODE_TYPES = [
  'trigger',
  'ai',
  'skill',
  'connector',
  'condition',
  'approval',
  'delay',
  'checkpoint',
  'end',
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];
export const WORKFLOW_NODE_LABEL: Record<WorkflowNodeType, string> = {
  trigger: 'Bắt đầu',
  ai: 'AI',
  skill: 'Skill',
  connector: 'Connector',
  condition: 'Điều kiện',
  approval: 'Duyệt',
  delay: 'Chờ',
  checkpoint: 'Điểm lưu',
  end: 'Kết thúc',
};

export const CONDITION_OPERATORS = [
  'contains',
  'not_contains',
  'equals',
  'is_empty',
  'not_empty',
  'number_gt',
  'number_lt',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export const CONDITION_OPERATOR_LABEL: Record<ConditionOperator, string> = {
  contains: 'có chứa',
  not_contains: 'không chứa',
  equals: 'bằng',
  is_empty: 'trống',
  not_empty: 'không trống',
  number_gt: 'là số lớn hơn',
  number_lt: 'là số nhỏ hơn',
};

export const WORKFLOW_RUN_STATUSES = [
  'running',
  'waiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];
export const WORKFLOW_RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  running: 'Đang chạy',
  waiting_approval: 'Chờ duyệt',
  paused: 'Tạm dừng',
  completed: 'Hoàn thành',
  failed: 'Lỗi',
  cancelled: 'Đã hủy',
};

const nodeId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'mã bước chỉ gồm chữ thường không dấu, số và _');
const workflowKey = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'mã Workflow chỉ gồm chữ thường không dấu, số, - và _');
const template = (max: number) => z.string().max(max);
/** Where to go next: a node id, null to end the run, or left out for the step listed below. */
const nextRef = nodeId.nullable().optional();

const base = { id: nodeId, label: z.string().trim().min(1).max(80), next: nextRef };

export const workflowNodeSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('trigger'),
    inputs: z.array(skillFieldSchema).max(SKILL_MAX_INPUTS),
  }),
  z.object({
    ...base,
    type: z.literal('ai'),
    prompt: template(8000).trim().min(1),
    agentKey: z.string().max(64).nullable().optional(),
    requiredLevel: taskLevelSchema.default('prepare'),
    budgetUsd: z.number().positive().max(10),
    timeoutSec: z.number().int().min(10).max(600).default(120),
  }),
  z.object({
    ...base,
    type: z.literal('skill'),
    skillKey: z.string().max(64),
    inputs: z.record(z.string(), template(SKILL_INPUT_MAX_CHARS)),
    agentKey: z.string().max(64).nullable().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('connector'),
    connectorKey: z.string().max(64),
    capability: z.string().max(40),
    inputs: z.record(z.string(), template(SKILL_INPUT_MAX_CHARS)),
  }),
  z.object({
    ...base,
    type: z.literal('condition'),
    value: template(2000),
    operator: z.enum(CONDITION_OPERATORS),
    compare: z.string().max(200).default(''),
    then: nodeId.nullable(),
    else: nodeId.nullable(),
  }),
  z.object({
    ...base,
    type: z.literal('approval'),
    message: template(2000).trim().min(1),
    onReject: nodeId.nullable().default(null),
  }),
  z.object({ ...base, type: z.literal('delay'), seconds: z.number().int().min(1).max(86_400) }),
  z.object({ ...base, type: z.literal('checkpoint') }),
  z.object({ ...base, type: z.literal('end') }),
]);
export type WorkflowNode = z.output<typeof workflowNodeSchema>;
export type WorkflowNodeInput = z.input<typeof workflowNodeSchema>;

const TEMPLATE_RE = /\{\{\s*(input|steps)\.([a-z][a-z0-9_]*)\s*\}\}/g;
/** References like {{input.product}} or {{steps.write}} in a template. */
export function templateRefs(text: string): { kind: 'input' | 'steps'; name: string }[] {
  return [...text.matchAll(TEMPLATE_RE)].map((m) => ({
    kind: m[1] as 'input' | 'steps',
    name: m[2]!,
  }));
}
/** Every template a node holds. */
export function nodeTemplates(n: WorkflowNode): string[] {
  switch (n.type) {
    case 'ai':
      return [n.prompt];
    case 'skill':
    case 'connector':
      return Object.values(n.inputs);
    case 'condition':
      return [n.value];
    case 'approval':
      return [n.message];
    default:
      return [];
  }
}
/** The nodes a node can go to: its next (or the one listed below it), and the branches. */
export function nodeTargets(nodes: WorkflowNode[], i: number): (string | null)[] {
  const n = nodes[i]!;
  const following = n.next === undefined ? (nodes[i + 1]?.id ?? null) : n.next;
  if (n.type === 'condition') return [n.then, n.else];
  if (n.type === 'approval') return [following, n.onReject];
  if (n.type === 'end') return [null];
  return [following];
}

export const workflowGraphSchema = z
  .object({
    maxSteps: z.number().int().min(1).max(WORKFLOW_MAX_STEPS).default(50),
    nodes: z.array(workflowNodeSchema).min(2).max(WORKFLOW_MAX_NODES),
  })
  .superRefine((g, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message, path: ['nodes'] });
    const ids = g.nodes.map((n) => n.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) issue(`mã bước "${dup}" bị trùng`);
    if (g.nodes[0]?.type !== 'trigger') issue('bước đầu tiên phải là "Bắt đầu"');
    if (g.nodes.filter((n) => n.type === 'trigger').length > 1) issue('chỉ có một bước "Bắt đầu"');
    const trigger = g.nodes[0]?.type === 'trigger' ? g.nodes[0] : null;
    const inputNames = new Set(trigger?.inputs.map((f) => f.name) ?? []);
    g.nodes.forEach((n, i) => {
      for (const t of nodeTargets(g.nodes, i)) {
        if (t !== null && !ids.includes(t)) issue(`bước "${n.label}" trỏ tới bước không có: ${t}`);
        if (t === g.nodes[0]?.id) issue(`bước "${n.label}" không được quay lại bước "Bắt đầu"`);
      }
      for (const text of nodeTemplates(n)) {
        for (const r of templateRefs(text)) {
          if (r.kind === 'input' && !inputNames.has(r.name))
            issue(`bước "${n.label}" dùng ô nhập không có: ${r.name}`);
          if (r.kind === 'steps' && !ids.includes(r.name))
            issue(`bước "${n.label}" dùng kết quả của bước không có: ${r.name}`);
        }
      }
    });
  });
export type WorkflowGraph = z.output<typeof workflowGraphSchema>;
export type WorkflowGraphInput = z.input<typeof workflowGraphSchema>;

export const createWorkflowSchema = z.object({
  key: workflowKey,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  graph: workflowGraphSchema,
});
export type CreateWorkflow = z.input<typeof createWorkflowSchema>;

export const updateWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500),
    status: z.enum(['active', 'paused']),
    graph: workflowGraphSchema,
    note: z.string().trim().max(200),
  })
  .partial();
export type UpdateWorkflow = z.input<typeof updateWorkflowSchema>;

export const copyWorkflowSchema = z.object({
  key: workflowKey,
  name: z.string().trim().min(1).max(80),
});
export type CopyWorkflow = z.input<typeof copyWorkflowSchema>;

export const workflowManifestSchema = z.object({
  format: z.literal(WORKFLOW_FORMAT),
  key: workflowKey,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  version: z.number().int().min(1),
  graph: workflowGraphSchema,
  checksum: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type WorkflowManifest = z.output<typeof workflowManifestSchema>;

export const importWorkflowSchema = z.object({
  manifest: z.unknown(),
  replace: z.boolean().default(false),
});
export type ImportWorkflow = z.input<typeof importWorkflowSchema>;

const runInputs = z.record(
  z.string(),
  z.union([z.string().max(SKILL_INPUT_MAX_CHARS), z.number()]),
);
export const startWorkflowRunSchema = z.object({
  inputs: runInputs,
  budgetUsd: z.number().positive().max(50),
});
export type StartWorkflowRun = z.infer<typeof startWorkflowRunSchema>;
export const testWorkflowSchema = z.object({ inputs: runInputs });
export type TestWorkflow = z.infer<typeof testWorkflowSchema>;
export const workflowDecisionSchema = z.object({ note: z.string().trim().max(500).optional() });
export type WorkflowDecision = z.infer<typeof workflowDecisionSchema>;

export interface WorkflowResponse {
  id: string;
  key: string;
  name: string;
  description: string;
  source: 'template' | 'created' | 'imported' | 'copied';
  status: 'active' | 'paused';
  version: number;
  graph: WorkflowGraph;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowVersionResponse {
  version: number;
  checksum: string;
  note: string | null;
  nodes: number;
  createdAt: string;
}
export interface WorkflowRunResponse {
  id: string;
  workflowId: string;
  version: number;
  status: WorkflowRunStatus;
  input: Record<string, string | number>;
  currentNode: string | null;
  waitingFor: 'task' | 'approval' | 'delay' | 'connector' | null;
  budgetUsd: number;
  costUsd: number;
  stepsTaken: number;
  hasCheckpoint: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  startedBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}
export interface WorkflowRunStepResponse {
  seq: number;
  nodeId: string;
  nodeType: WorkflowNodeType;
  label: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  input: string | null;
  output: string | null;
  taskId: string | null;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
}
export interface WorkflowRunDetailResponse extends WorkflowRunResponse {
  steps: WorkflowRunStepResponse[];
}
/** A test run: the path the run would take, with placeholders for AI results. Nothing is saved or spent. */
export interface WorkflowTestResponse {
  steps: {
    nodeId: string;
    nodeType: WorkflowNodeType;
    label: string;
    input: string | null;
    output: string | null;
  }[];
  outcome: 'completed' | 'step_limit';
  aiSteps: number;
  maxBudgetUsd: number;
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  /** Skills the template uses; they come from the starter skills. */
  skills: string[];
  graph: WorkflowGraphInput;
}

const f = (
  name: string,
  label: string,
  type: SkillField['type'] = 'text',
  required = true,
): SkillField => ({ name, label, type, required });
const level = (l: TaskLevel) => l;

/** Starter workflows built on the starter skills. */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    key: 'ra-mat-san-pham',
    name: 'Ra mắt sản phẩm mới',
    description: 'Viết mô tả sản phẩm và bài quảng cáo Facebook, rồi chờ bạn duyệt cả hai.',
    skills: ['mo-ta-san-pham', 'bai-quang-cao-facebook'],
    graph: {
      maxSteps: 20,
      nodes: [
        {
          id: 'bat_dau',
          type: 'trigger',
          label: 'Thông tin sản phẩm',
          inputs: [
            f('san_pham', 'Tên sản phẩm'),
            f('dac_diem', 'Đặc điểm nổi bật', 'long_text'),
            f('khach_hang', 'Khách hàng mục tiêu'),
          ],
        },
        {
          id: 'mo_ta',
          type: 'skill',
          label: 'Viết mô tả sản phẩm',
          skillKey: 'mo-ta-san-pham',
          inputs: { san_pham: '{{input.san_pham}}', dac_diem: '{{input.dac_diem}}', san: 'Shopee' },
        },
        { id: 'luu_mo_ta', type: 'checkpoint', label: 'Lưu sau khi có mô tả' },
        {
          id: 'quang_cao',
          type: 'skill',
          label: 'Viết bài quảng cáo',
          skillKey: 'bai-quang-cao-facebook',
          inputs: { san_pham: '{{input.san_pham}}', khach_hang: '{{input.khach_hang}}' },
        },
        {
          id: 'duyet',
          type: 'approval',
          label: 'Duyệt nội dung',
          message: 'Đọc mô tả và bài quảng cáo cho {{input.san_pham}} trước khi đăng.',
          onReject: null,
        },
        { id: 'xong', type: 'end', label: 'Xong' },
      ],
    },
  },
  {
    key: 'xu-ly-danh-gia',
    name: 'Xử lý đánh giá của khách',
    description:
      'Phân loại một đánh giá; đánh giá tiêu cực được soạn câu trả lời và chờ duyệt, đánh giá tốt được soạn lời cảm ơn.',
    skills: ['tra-loi-khach-hang'],
    graph: {
      maxSteps: 20,
      nodes: [
        {
          id: 'bat_dau',
          type: 'trigger',
          label: 'Đánh giá mới',
          inputs: [f('danh_gia', 'Nội dung đánh giá', 'long_text')],
        },
        {
          id: 'phan_loai',
          type: 'ai',
          label: 'Phân loại đánh giá',
          prompt:
            'Đánh giá sau của khách là tích cực hay tiêu cực? Chỉ trả lời đúng một từ: TICH_CUC hoặc TIEU_CUC.\n\nĐánh giá: {{input.danh_gia}}',
          requiredLevel: level('analyze'),
          budgetUsd: 0.1,
          timeoutSec: 60,
        },
        {
          id: 'la_tieu_cuc',
          type: 'condition',
          label: 'Có tiêu cực không?',
          value: '{{steps.phan_loai}}',
          operator: 'contains',
          compare: 'TIEU_CUC',
          then: 'tra_loi',
          else: 'cam_on',
        },
        {
          id: 'tra_loi',
          type: 'skill',
          label: 'Soạn câu trả lời',
          skillKey: 'tra-loi-khach-hang',
          inputs: { tin_nhan: '{{input.danh_gia}}' },
        },
        {
          id: 'duyet',
          type: 'approval',
          label: 'Duyệt câu trả lời',
          message: 'Đọc câu trả lời trước khi gửi cho khách.',
          next: null,
          onReject: null,
        },
        {
          id: 'cam_on',
          type: 'ai',
          label: 'Soạn lời cảm ơn',
          prompt:
            'Viết một lời cảm ơn ngắn, chân thành (dưới 50 chữ) cho khách đã để lại đánh giá này: {{input.danh_gia}}',
          requiredLevel: level('prepare'),
          budgetUsd: 0.1,
          timeoutSec: 60,
          next: null,
        },
      ],
    },
  },
];
