import { z } from 'zod';
import { modelName } from './ai';

export const COUNCIL_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type CouncilStatus = (typeof COUNCIL_STATUSES)[number];

export const COUNCIL_STATUS_LABEL: Record<CouncilStatus, string> = {
  queued: 'Đang chờ',
  running: 'Đang họp',
  completed: 'Hoàn thành',
  failed: 'Lỗi',
  cancelled: 'Đã hủy',
};

export const COUNCIL_STAGE_LABEL = {
  answer: 'Trả lời độc lập',
  critique: 'Phản biện',
  synthesis: 'Tổng hợp',
} as const;
export type CouncilStage = keyof typeof COUNCIL_STAGE_LABEL;

export const COUNCIL_MIN_MEMBERS = 2;
export const COUNCIL_MAX_MEMBERS = 4;

export const councilMemberSchema = z.object({
  providerId: z.string().uuid(),
  /** Empty = the provider's default model. */
  model: modelName.optional(),
});

export const createCouncilSchema = z.object({
  question: z.string().trim().min(1).max(8000),
  members: z.array(councilMemberSchema).min(COUNCIL_MIN_MEMBERS).max(COUNCIL_MAX_MEMBERS),
  critique: z.boolean().default(true),
  maxCostUsd: z.number().positive().max(50),
  projectId: z.string().uuid().nullable().optional(),
});
export type CreateCouncil = z.input<typeof createCouncilSchema>;

export interface CouncilTurnResponse {
  id: string;
  stage: CouncilStage;
  memberIndex: number;
  providerId: string | null;
  model: string | null;
  status: 'complete' | 'error' | 'cancelled';
  content: string;
  errorCode: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface CouncilResponse {
  id: string;
  question: string;
  members: { providerId: string; model: string }[];
  critique: boolean;
  maxCostUsd: number;
  projectId: string | null;
  status: CouncilStatus;
  stage: string | null;
  synthesis: string | null;
  costUsd: number;
  errorCode: string | null;
  createdBy: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CouncilDetailResponse extends CouncilResponse {
  turns: CouncilTurnResponse[];
}
