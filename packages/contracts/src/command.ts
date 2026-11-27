import { z } from 'zod';
import type { TaskLevel } from './access-levels';
import type { TaskResponse } from './tasks';

export const PLAN_STATUSES = ['planning', 'proposed', 'accepted', 'discarded', 'failed'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  planning: 'Đang lập kế hoạch',
  proposed: 'Chờ bạn xem',
  accepted: 'Đã tạo công việc',
  discarded: 'Đã bỏ',
  failed: 'Lỗi',
};

export const PLAN_MAX_STEPS = 8;

export const createPlanSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
  /** Total budget for all the plan's tasks. */
  budgetUsd: z.number().positive().max(1000),
  projectId: z.string().uuid().nullable().optional(),
});
export type CreatePlan = z.infer<typeof createPlanSchema>;

export interface PlanStepResponse {
  title: string;
  goal: string;
  scope: string;
  successCriteria: string;
  agentId: string | null;
  requiredLevel: TaskLevel;
  budgetUsd: number;
  /** Why the step has no agent, or other remarks from MARIS. */
  note: string | null;
}

export interface PlanResponse {
  id: string;
  goal: string;
  projectId: string | null;
  budgetUsd: number;
  status: PlanStatus;
  summary: string | null;
  steps: PlanStepResponse[];
  reportStatus: 'running' | 'completed' | 'failed' | null;
  report: string | null;
  costUsd: number;
  errorCode: string | null;
  createdBy: string;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDetailResponse extends PlanResponse {
  /** The tasks created from the plan, in step order (empty until accepted). */
  tasks: TaskResponse[];
}
