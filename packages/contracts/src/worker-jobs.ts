import { z } from 'zod';
import { DEVICE_KINDS, type DeviceKind } from './devices';

/**
 * Work for workers (spec Part 26). Each kind is implemented inside the worker program; there is no
 * kind that runs a shell command or code sent from the server. Code runs wait for the sandbox.
 */
export const WORKER_JOB_KINDS = ['diagnostics', 'ollama.generate', 'test.wait'] as const;
export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];

export const WORKER_JOB_KIND_INFO: Record<
  WorkerJobKind,
  { label: string; description: string; timeoutSec: number }
> = {
  diagnostics: {
    label: 'Kiểm tra máy',
    description: 'Báo cáo chi tiết hệ điều hành, CPU, RAM, ổ đĩa, GPU, Node.js và độ trễ tới MARIS',
    timeoutSec: 60,
  },
  'ollama.generate': {
    label: 'AI cục bộ (Ollama)',
    description: 'Chạy một model trên Ollama của chính máy đó (127.0.0.1:11434), không tốn phí API',
    timeoutSec: 900,
  },
  'test.wait': {
    label: 'Việc thử',
    description: 'Đếm giây và báo tiến độ, để thử phân việc, hủy và chuyển máy',
    timeoutSec: 900,
  },
};

export const WORKER_JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkerJobStatus = (typeof WORKER_JOB_STATUSES)[number];
export const WORKER_JOB_STATUS_LABEL: Record<WorkerJobStatus, string> = {
  queued: 'Đang chờ',
  running: 'Đang chạy',
  completed: 'Xong',
  failed: 'Lỗi',
  cancelled: 'Đã hủy',
};

/** A worker holds a job this long after each report; then it goes back to the queue. */
export const JOB_LEASE_SEC = 60;
/** How often an idle worker asks for work. */
export const JOB_POLL_SEC = 5;
/** Largest result a worker may send back, in bytes of JSON. */
export const JOB_RESULT_MAX_BYTES = 64 * 1024;

export const workerJobInputSchemas = {
  diagnostics: z.object({}).strict(),
  'ollama.generate': z
    .object({
      model: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._:/-]{1,100}$/, 'Tên model chỉ gồm chữ, số và . _ : / -'),
      prompt: z.string().trim().min(1).max(20_000),
      maxTokens: z.number().int().min(1).max(8192).default(512),
    })
    .strict(),
  'test.wait': z
    .object({
      seconds: z.number().int().min(1).max(600).default(30),
      /** Fail at the end, to try error handling. */
      fail: z.boolean().default(false),
    })
    .strict(),
} satisfies Record<WorkerJobKind, z.ZodType>;
export type WorkerJobInput<K extends WorkerJobKind> = z.infer<(typeof workerJobInputSchemas)[K]>;

export const createWorkerJobSchema = z.object({
  kind: z.enum(WORKER_JOB_KINDS),
  title: z.string().trim().min(1).max(120).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  priority: z.number().int().min(-10).max(10).default(0),
  /** Only this device. */
  targetDeviceId: z.uuid().nullable().default(null),
  /** Only these kinds of device; empty means any. */
  targetKinds: z.array(z.enum(DEVICE_KINDS)).max(DEVICE_KINDS.length).default([]),
  needGpu: z.boolean().default(false),
  minFreeRamMb: z.number().int().min(0).max(10_000_000).default(0),
  timeoutSec: z.number().int().min(10).max(86_400).optional(),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});
export type CreateWorkerJob = z.input<typeof createWorkerJobSchema>;

const logLine = z.object({
  level: z.enum(['info', 'warning', 'error']).default('info'),
  message: z.string().trim().min(1).max(1000),
});

export const claimJobSchema = z.object({});
export type ClaimJob = z.input<typeof claimJobSchema>;

export const jobProgressSchema = z.object({
  progress: z.number().int().min(0).max(100).optional(),
  note: z.string().trim().max(200).optional(),
  logs: z.array(logLine).max(20).default([]),
});
export type JobProgress = z.input<typeof jobProgressSchema>;

export const finishJobSchema = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
  result: z.unknown().optional(),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,59}$/)
    .optional(),
  errorMessage: z.string().trim().max(1000).optional(),
  logs: z.array(logLine).max(20).default([]),
});
export type FinishJob = z.input<typeof finishJobSchema>;

/** What a worker gets when it claims a job. */
export interface AgentJob {
  id: string;
  kind: WorkerJobKind;
  input: Record<string, unknown>;
  timeoutSec: number;
  leaseSec: number;
}

export interface ClaimJobResponse {
  job: AgentJob | null;
  pollSec: number;
}

export interface JobProgressResponse {
  /** Stop now: the job was cancelled, moved to another worker, or ran past its time. */
  cancel: boolean;
  leaseSec: number;
}

export interface WorkerJobResponse {
  id: string;
  kind: WorkerJobKind;
  title: string;
  input: Record<string, unknown>;
  status: WorkerJobStatus;
  priority: number;
  targetDeviceId: string | null;
  targetKinds: DeviceKind[];
  needGpu: boolean;
  minFreeRamMb: number;
  timeoutSec: number;
  maxAttempts: number;
  attempts: number;
  deviceId: string | null;
  deviceName: string | null;
  progress: number;
  progressNote: string | null;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkerJobLogResponse {
  id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  deviceId: string | null;
  createdAt: string;
}
