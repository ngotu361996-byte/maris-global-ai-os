/**
 * System monitoring (spec Part 27/28 monitoring): one read-only snapshot of the API process, the
 * database, Redis, the job queues and the tenant's recent errors, with checks worked out on the
 * server so every screen shows the same verdict.
 */

export const CHECK_STATUSES = ['ok', 'warning', 'error'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export const CHECK_STATUS_LABEL: Record<CheckStatus, string> = {
  ok: 'Ổn định',
  warning: 'Cần chú ý',
  error: 'Có lỗi',
};

/** Where the checks turn to warning or error. */
export const MONITOR_LIMITS = {
  dbLatencyWarnMs: 200,
  redisLatencyWarnMs: 100,
  heapWarnPct: 90,
  queueFailedWarn: 1,
  queueWaitingWarn: 100,
  outboxPendingWarn: 50,
  outboxOldestWarnSec: 300,
  aiErrorRateWarnPct: 20,
  aiErrorRateErrorPct: 50,
  aiMinCallsForRate: 5,
} as const;

/** How often the page refreshes. */
export const MONITOR_REFRESH_SEC = 15;

export const QUEUE_LABEL: Record<string, string> = {
  'maris-tasks': 'Việc AI',
  'maris-plans': 'Kế hoạch AI',
  'maris-council': 'Hội đồng AI',
  'maris-workflows': 'Workflow',
  'maris-events': 'Sự kiện (lưu cho dịch vụ sau)',
};
/**
 * Queues that hold events for services added later (Part 9 event bus). Nothing reads them yet, so
 * their waiting count grows by design and is shown but not counted as a backlog.
 */
export const EVENT_LOG_QUEUES: readonly string[] = ['maris-events'];

export interface MonitorCheck {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface QueueStats {
  name: string;
  label: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export interface SystemMonitorResponse {
  status: CheckStatus;
  checkedAt: string;
  checks: MonitorCheck[];
  api: {
    uptimeSec: number;
    nodeVersion: string;
    rssMb: number;
    heapUsedMb: number;
    heapLimitMb: number;
    pid: number;
  };
  database: {
    up: boolean;
    latencyMs: number | null;
    sizeMb: number | null;
    connections: number | null;
    version: string | null;
  };
  redis: {
    up: boolean;
    latencyMs: number | null;
    usedMemoryMb: number | null;
    version: string | null;
  };
  queues: QueueStats[];
  outbox: { pending: number; oldestPendingSec: number | null };
  /** This tenant's activity in the last 24 hours (and the last hour for AI calls). */
  activity: {
    aiCalls24h: number;
    aiErrors24h: number;
    aiCalls1h: number;
    aiErrors1h: number;
    aiAvgLatencyMs24h: number | null;
    tasksFailed24h: number;
    workflowRunsFailed24h: number;
    workflowRunsWaitingApproval: number;
    connectorCallsFailed24h: number;
    workerJobsQueued: number;
    workerJobsRunning: number;
    workerJobsFailed24h: number;
  };
  devices: { total: number; online: number; offline: number; withWarnings: number };
  /** Recent failures across the system, newest first. */
  recentErrors: {
    source: 'ai' | 'task' | 'workflow' | 'connector' | 'worker_job';
    message: string;
    at: string;
  }[];
}
