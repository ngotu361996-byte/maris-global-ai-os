import { z } from 'zod';

/** Access levels from spec Part 06, lowest first. */
export const ACCESS_LEVELS = ['read', 'analyze', 'plan', 'prepare', 'execute', 'control', 'develop', 'deploy'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_LEVEL_LABEL: Record<AccessLevel, string> = {
  read: 'Chỉ đọc',
  analyze: 'Phân tích',
  plan: 'Lập kế hoạch',
  prepare: 'Chuẩn bị công việc',
  execute: 'Thực thi',
  control: 'Điều khiển tài nguyên',
  develop: 'Phát triển (môi trường cách ly)',
  deploy: 'Phát hành (sau phê duyệt)',
};

/** Levels a task can require in Phase 3, where a task only produces text. */
export const TASK_LEVELS = ['read', 'analyze', 'plan', 'prepare'] as const;
export type TaskLevel = (typeof TASK_LEVELS)[number];

export const accessLevelSchema = z.enum(ACCESS_LEVELS);
export const taskLevelSchema = z.enum(TASK_LEVELS);

/** True when `has` is at least `needs`. */
export function levelAtLeast(has: AccessLevel, needs: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(has) >= ACCESS_LEVELS.indexOf(needs);
}
