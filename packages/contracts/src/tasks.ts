import { z } from 'zod';
import { taskLevelSchema, type TaskLevel } from './access-levels';

export const TASK_STATUSES = ['pending', 'rejected', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Chờ duyệt',
  rejected: 'Bị từ chối',
  queued: 'Đã duyệt, chờ chạy',
  running: 'Đang chạy',
  paused: 'Tạm dừng',
  completed: 'Hoàn thành',
  failed: 'Lỗi',
  cancelled: 'Đã hủy',
};

/** What a task may do. In Phase 3 the only action is producing text with an AI. */
export const TASK_PERMISSIONS = ['ai.generate_text'] as const;

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(4000),
  scope: z.string().trim().min(1).max(4000),
  successCriteria: z.string().trim().min(1).max(2000),
  budgetUsd: z.number().positive().max(1000),
  agentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  /** The lowest agent access level the work needs. */
  requiredLevel: taskLevelSchema.optional(),
});
export type CreateTask = z.infer<typeof createTaskSchema>;

export const taskDecisionSchema = z.object({ note: z.string().trim().max(1000).optional() });
export type TaskDecision = z.infer<typeof taskDecisionSchema>;

export interface TaskResponse {
  id: string;
  title: string;
  goal: string;
  scope: string;
  successCriteria: string;
  permissions: string[];
  budgetUsd: number;
  agentId: string | null;
  projectId: string | null;
  conversationId: string | null;
  planId: string | null;
  stepIndex: number | null;
  requiredLevel: TaskLevel;
  skillId: string | null;
  skillVersion: string | null;
  workflowRunId: string | null;
  status: TaskStatus;
  progress: string | null;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  decisionNote: string | null;
  result: string | null;
  costUsd: number;
  attempts: number;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const emergencyStopSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type EmergencyStop = z.infer<typeof emergencyStopSchema>;

export interface AiControlResponse {
  emergencyStop: boolean;
  reason: string | null;
  changedAt: string | null;
}

export const upsertBudgetSchema = z.object({
  /** null = whole tenant. */
  providerId: z.string().uuid().nullable(),
  monthlyUsd: z.number().positive().max(1_000_000),
});
export type UpsertBudget = z.infer<typeof upsertBudgetSchema>;

export interface BudgetResponse {
  id: string;
  providerId: string | null;
  monthlyUsd: number;
  spentUsd: number;
  /** spent / budget, 0..n */
  ratio: number;
  state: 'ok' | 'warning' | 'exceeded';
  month: string;
}

/** Summary for the "Công việc đang chạy" bar. */
export interface AiActivityResponse {
  control: AiControlResponse;
  pending: number;
  queued: number;
  running: TaskResponse[];
  budgetWarnings: number;
}
