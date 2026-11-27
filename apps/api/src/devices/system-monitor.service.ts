import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { sql } from 'drizzle-orm';
import {
  MONITOR_LIMITS,
  QUEUE_LABEL,
  type CheckStatus,
  type MonitorCheck,
  type QueueStats,
  type SystemMonitorResponse,
} from '@maris/contracts';
import { getHeapStatistics } from 'node:v8';
import type { Ctx } from '../ai/chat.service';
import { COUNCIL_QUEUE } from '../ai/council.service';
import { PLANS_QUEUE } from '../ai/plans.service';
import { TASKS_QUEUE } from '../ai/tasks.service';
import { DbService } from '../db/db.service';
import { EVENTS_QUEUE } from '../outbox/outbox.service';
import { RedisService } from '../redis/redis.module';
import { WORKFLOWS_QUEUE } from '../workflows/workflow-runs.service';
import { DevicesService } from './devices.service';

const QUEUES = [TASKS_QUEUE, PLANS_QUEUE, COUNCIL_QUEUE, WORKFLOWS_QUEUE, EVENTS_QUEUE];
/** No single probe may hold up the page; a dead Redis would otherwise block forever. */
const PROBE_MS = 3000;
const MB = 1024 * 1024;

const within = <T>(p: Promise<T>, ms = PROBE_MS): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);

const timed = async <T>(p: () => Promise<T>): Promise<{ value: T; ms: number } | null> => {
  const t0 = performance.now();
  try {
    const value = await within(p());
    return { value, ms: Math.round(performance.now() - t0) };
  } catch {
    return null;
  }
};

const infoField = (info: string, key: string): string | null =>
  new RegExp(`^${key}:(.*)$`, 'm').exec(info)?.[1]?.trim() ?? null;

const worst = (a: CheckStatus, b: CheckStatus): CheckStatus =>
  a === 'error' || b === 'error' ? 'error' : a === 'warning' || b === 'warning' ? 'warning' : 'ok';

const n = (v: unknown): number => Number(v ?? 0);

/**
 * System monitoring (spec Part 27/28). Read-only: it never changes data, so it writes no audit.
 * The API process, database, Redis and queues are this installation's; activity, outbox, worker
 * jobs and devices are read through the tenant's RLS context.
 */
@Injectable()
export class SystemMonitorService implements OnModuleDestroy {
  private connection: Redis | null = null;
  private queues = new Map<string, Queue>();

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly devices: DevicesService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
    await this.connection?.quit().catch(() => undefined);
  }

  async snapshot(ctx: Ctx): Promise<SystemMonitorResponse> {
    const [database, redis, queues, tenant, deviceList] = await Promise.all([
      this.database(),
      this.redisStats(),
      this.queueStats(),
      this.tenantStats(ctx),
      within(this.devices.list(ctx), 10_000).catch(() => null),
    ]);
    const mem = process.memoryUsage();
    const heapLimit = getHeapStatistics().heap_size_limit;
    const api = {
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      rssMb: Math.round(mem.rss / MB),
      heapUsedMb: Math.round(mem.heapUsed / MB),
      heapLimitMb: Math.round(heapLimit / MB),
      pid: process.pid,
    };
    const devices = deviceList
      ? {
          total: deviceList.filter((d) => d.status !== 'revoked').length,
          online: deviceList.filter((d) => d.online).length,
          offline: deviceList.filter((d) => d.status === 'active' && !d.online).length,
          withWarnings: deviceList.filter((d) => d.warnings.length > 0).length,
        }
      : { total: 0, online: 0, offline: 0, withWarnings: 0 };

    const checks = buildChecks({ api, database, redis, queues, tenant, devices, deviceList });
    return {
      status: checks.reduce<CheckStatus>((s, c) => worst(s, c.status), 'ok'),
      checkedAt: new Date().toISOString(),
      checks,
      api,
      database,
      redis,
      queues: queues ?? [],
      outbox: tenant?.outbox ?? { pending: 0, oldestPendingSec: null },
      activity: tenant?.activity ?? emptyActivity(),
      devices,
      recentErrors: tenant?.recentErrors ?? [],
    };
  }

  private async database(): Promise<SystemMonitorResponse['database']> {
    const ping = await timed(() => this.db.client`SELECT 1`);
    if (!ping)
      return { up: false, latencyMs: null, sizeMb: null, connections: null, version: null };
    const stats = await within(
      this.db.client<{ size: string; conns: number; version: string }[]>`
        SELECT pg_database_size(current_database())::text AS size,
               (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS conns,
               current_setting('server_version') AS version`,
    ).catch(() => null);
    const row = stats?.[0];
    return {
      up: true,
      latencyMs: ping.ms,
      sizeMb: row ? Math.round((Number(row.size) / MB) * 10) / 10 : null,
      connections: row?.conns ?? null,
      version: row?.version ?? null,
    };
  }

  private async redisStats(): Promise<SystemMonitorResponse['redis']> {
    const ping = await timed(() => this.redis.client.ping());
    if (!ping || ping.value !== 'PONG')
      return { up: false, latencyMs: null, usedMemoryMb: null, version: null };
    const info = await within(this.redis.client.info()).catch(() => '');
    const used = infoField(info, 'used_memory');
    return {
      up: true,
      latencyMs: ping.ms,
      usedMemoryMb: used ? Math.round((Number(used) / MB) * 10) / 10 : null,
      version: infoField(info, 'redis_version'),
    };
  }

  private async queueStats(): Promise<QueueStats[] | null> {
    try {
      if (!this.connection) this.connection = this.redis.duplicate();
      return await within(
        Promise.all(
          QUEUES.map(async (name) => {
            let q = this.queues.get(name);
            if (!q) {
              q = new Queue(name, { connection: this.connection! });
              this.queues.set(name, q);
            }
            const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
            return {
              name,
              label: QUEUE_LABEL[name] ?? name,
              waiting: n(c.waiting),
              active: n(c.active),
              delayed: n(c.delayed),
              failed: n(c.failed),
              completed: n(c.completed),
            };
          }),
        ),
      );
    } catch {
      return null;
    }
  }

  private tenantStats(ctx: Ctx) {
    return within(
      this.db.withContext(ctx, async (tx) => {
        const t = ctx.tenantId;
        const [a] = (await tx.execute(sql`
          SELECT
            (SELECT count(*)::int FROM ai.provider_calls WHERE tenant_id = ${t} AND created_at > now() - interval '24 hours') AS ai_calls_24h,
            (SELECT count(*)::int FROM ai.provider_calls WHERE tenant_id = ${t} AND created_at > now() - interval '24 hours' AND outcome IN ('error', 'timeout', 'circuit_open')) AS ai_errors_24h,
            (SELECT count(*)::int FROM ai.provider_calls WHERE tenant_id = ${t} AND created_at > now() - interval '1 hour') AS ai_calls_1h,
            (SELECT count(*)::int FROM ai.provider_calls WHERE tenant_id = ${t} AND created_at > now() - interval '1 hour' AND outcome IN ('error', 'timeout', 'circuit_open')) AS ai_errors_1h,
            (SELECT round(avg(latency_ms))::int FROM ai.provider_calls WHERE tenant_id = ${t} AND created_at > now() - interval '24 hours' AND outcome = 'ok') AS ai_avg_latency,
            (SELECT count(*)::int FROM ai.tasks WHERE tenant_id = ${t} AND status = 'failed' AND updated_at > now() - interval '24 hours') AS tasks_failed,
            (SELECT count(*)::int FROM work.workflow_runs WHERE tenant_id = ${t} AND status = 'failed' AND updated_at > now() - interval '24 hours') AS runs_failed,
            (SELECT count(*)::int FROM work.workflow_runs WHERE tenant_id = ${t} AND status = 'waiting_approval') AS runs_waiting,
            (SELECT count(*)::int FROM integration.connector_calls WHERE tenant_id = ${t} AND status = 'failed' AND created_at > now() - interval '24 hours') AS connector_failed,
            (SELECT count(*)::int FROM infra.worker_jobs WHERE tenant_id = ${t} AND status = 'queued') AS jobs_queued,
            (SELECT count(*)::int FROM infra.worker_jobs WHERE tenant_id = ${t} AND status = 'running') AS jobs_running,
            (SELECT count(*)::int FROM infra.worker_jobs WHERE tenant_id = ${t} AND status = 'failed' AND updated_at > now() - interval '24 hours') AS jobs_failed,
            (SELECT count(*)::int FROM work.outbox_events WHERE tenant_id = ${t} AND published_at IS NULL) AS outbox_pending,
            (SELECT extract(epoch FROM now() - min(created_at))::int FROM work.outbox_events WHERE tenant_id = ${t} AND published_at IS NULL) AS outbox_oldest
        `)) as unknown as Record<string, number | null>[];
        const errors = (await tx.execute(sql`
          (SELECT 'ai' AS source, model || ': ' || coalesce(error_code, outcome) AS message, created_at AS at
             FROM ai.provider_calls WHERE tenant_id = ${t} AND outcome IN ('error', 'timeout', 'circuit_open')
             ORDER BY created_at DESC LIMIT 5)
          UNION ALL
          (SELECT 'task', title || coalesce(': ' || left(result, 200), ''), updated_at
             FROM ai.tasks WHERE tenant_id = ${t} AND status = 'failed' ORDER BY updated_at DESC LIMIT 5)
          UNION ALL
          (SELECT 'workflow', coalesce(error_code, 'lỗi') || coalesce(': ' || left(error_message, 200), ''), updated_at
             FROM work.workflow_runs WHERE tenant_id = ${t} AND status = 'failed' ORDER BY updated_at DESC LIMIT 5)
          UNION ALL
          (SELECT 'connector', capability || ': ' || coalesce(error_code, 'lỗi') || coalesce(' ' || left(error_message, 200), ''), created_at
             FROM integration.connector_calls WHERE tenant_id = ${t} AND status = 'failed' ORDER BY created_at DESC LIMIT 5)
          UNION ALL
          (SELECT 'worker_job', title || ': ' || coalesce(error_code, 'lỗi') || coalesce(' ' || left(error_message, 200), ''), updated_at
             FROM infra.worker_jobs WHERE tenant_id = ${t} AND status = 'failed' ORDER BY updated_at DESC LIMIT 5)
          ORDER BY at DESC LIMIT 15
        `)) as unknown as { source: string; message: string; at: Date | string }[];
        const r = a ?? {};
        return {
          activity: {
            aiCalls24h: n(r.ai_calls_24h),
            aiErrors24h: n(r.ai_errors_24h),
            aiCalls1h: n(r.ai_calls_1h),
            aiErrors1h: n(r.ai_errors_1h),
            aiAvgLatencyMs24h: r.ai_avg_latency ?? null,
            tasksFailed24h: n(r.tasks_failed),
            workflowRunsFailed24h: n(r.runs_failed),
            workflowRunsWaitingApproval: n(r.runs_waiting),
            connectorCallsFailed24h: n(r.connector_failed),
            workerJobsQueued: n(r.jobs_queued),
            workerJobsRunning: n(r.jobs_running),
            workerJobsFailed24h: n(r.jobs_failed),
          },
          outbox: { pending: n(r.outbox_pending), oldestPendingSec: r.outbox_oldest ?? null },
          recentErrors: errors.map((e) => ({
            source: e.source as SystemMonitorResponse['recentErrors'][number]['source'],
            message: e.message,
            at: new Date(e.at).toISOString(),
          })),
        };
      }),
      10_000,
    ).catch(() => null);
  }
}

function emptyActivity(): SystemMonitorResponse['activity'] {
  return {
    aiCalls24h: 0,
    aiErrors24h: 0,
    aiCalls1h: 0,
    aiErrors1h: 0,
    aiAvgLatencyMs24h: null,
    tasksFailed24h: 0,
    workflowRunsFailed24h: 0,
    workflowRunsWaitingApproval: 0,
    connectorCallsFailed24h: 0,
    workerJobsQueued: 0,
    workerJobsRunning: 0,
    workerJobsFailed24h: 0,
  };
}

/** Turns the numbers into the checks shown at the top of the page. Exported for tests. */
export function buildChecks(s: {
  api: SystemMonitorResponse['api'];
  database: SystemMonitorResponse['database'];
  redis: SystemMonitorResponse['redis'];
  queues: QueueStats[] | null;
  tenant: {
    activity: SystemMonitorResponse['activity'];
    outbox: SystemMonitorResponse['outbox'];
  } | null;
  devices: SystemMonitorResponse['devices'];
  deviceList: unknown[] | null;
}): MonitorCheck[] {
  const L = MONITOR_LIMITS;
  const out: MonitorCheck[] = [];
  const add = (key: string, label: string, status: CheckStatus, detail: string) =>
    out.push({ key, label, status, detail });

  const heapPct = Math.round((s.api.heapUsedMb / Math.max(1, s.api.heapLimitMb)) * 100);
  add(
    'api',
    'Máy chủ API',
    heapPct >= L.heapWarnPct ? 'warning' : 'ok',
    `Chạy ${formatDuration(s.api.uptimeSec)}, bộ nhớ ${s.api.rssMb} MB (heap ${heapPct}%)`,
  );

  if (!s.database.up) add('database', 'Cơ sở dữ liệu', 'error', 'Không kết nối được PostgreSQL');
  else
    add(
      'database',
      'Cơ sở dữ liệu',
      (s.database.latencyMs ?? 0) > L.dbLatencyWarnMs ? 'warning' : 'ok',
      `Phản hồi ${s.database.latencyMs} ms, ${s.database.sizeMb ?? '?'} MB, ${s.database.connections ?? '?'} kết nối`,
    );

  if (!s.redis.up)
    add('redis', 'Redis', 'error', 'Không kết nối được Redis: hàng đợi và giới hạn tần suất dừng');
  else
    add(
      'redis',
      'Redis',
      (s.redis.latencyMs ?? 0) > L.redisLatencyWarnMs ? 'warning' : 'ok',
      `Phản hồi ${s.redis.latencyMs} ms, dùng ${s.redis.usedMemoryMb ?? '?'} MB`,
    );

  if (!s.queues) add('queues', 'Hàng đợi', 'error', 'Không đọc được hàng đợi');
  else {
    const failed = s.queues.reduce((x, q) => x + q.failed, 0);
    const waiting = s.queues.reduce((x, q) => x + q.waiting + q.delayed, 0);
    const busy = s.queues.filter((q) => q.waiting + q.delayed >= L.queueWaitingWarn);
    add(
      'queues',
      'Hàng đợi',
      failed >= L.queueFailedWarn || busy.length > 0 ? 'warning' : 'ok',
      [
        `${waiting} đang chờ, ${s.queues.reduce((x, q) => x + q.active, 0)} đang chạy`,
        failed > 0 ? `${failed} việc lỗi được giữ lại` : null,
        busy.length > 0 ? `ùn ở ${busy.map((q) => q.label).join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(', '),
    );
  }

  if (!s.tenant) {
    add('activity', 'Hoạt động', 'warning', 'Không đọc được số liệu hoạt động');
  } else {
    const o = s.tenant.outbox;
    const outboxBad =
      o.pending >= L.outboxPendingWarn || (o.oldestPendingSec ?? 0) >= L.outboxOldestWarnSec;
    add(
      'outbox',
      'Sự kiện chờ phát',
      outboxBad ? 'warning' : 'ok',
      o.pending === 0
        ? 'Không có sự kiện tồn'
        : `${o.pending} sự kiện chờ, cũ nhất ${formatDuration(o.oldestPendingSec ?? 0)}`,
    );

    const a = s.tenant.activity;
    const [calls, errors, window] =
      a.aiCalls1h >= L.aiMinCallsForRate
        ? [a.aiCalls1h, a.aiErrors1h, '1 giờ qua']
        : [a.aiCalls24h, a.aiErrors24h, '24 giờ qua'];
    const rate = calls > 0 ? Math.round((errors / calls) * 100) : 0;
    add(
      'ai',
      'Gọi AI',
      calls < L.aiMinCallsForRate
        ? errors > 0
          ? 'warning'
          : 'ok'
        : rate >= L.aiErrorRateErrorPct
          ? 'error'
          : rate >= L.aiErrorRateWarnPct
            ? 'warning'
            : 'ok',
      calls === 0
        ? 'Chưa có lượt gọi trong 24 giờ'
        : `${errors}/${calls} lượt lỗi (${rate}%) trong ${window}`,
    );

    const failures = [
      a.tasksFailed24h > 0 ? `${a.tasksFailed24h} việc AI` : null,
      a.workflowRunsFailed24h > 0 ? `${a.workflowRunsFailed24h} lượt workflow` : null,
      a.connectorCallsFailed24h > 0 ? `${a.connectorCallsFailed24h} lượt connector` : null,
      a.workerJobsFailed24h > 0 ? `${a.workerJobsFailed24h} việc Worker` : null,
    ].filter(Boolean);
    add(
      'failures',
      'Lỗi nghiệp vụ 24 giờ',
      failures.length > 0 ? 'warning' : 'ok',
      failures.length > 0 ? `Lỗi: ${failures.join(', ')}` : 'Không có việc nào lỗi',
    );
  }

  const d = s.devices;
  add(
    'devices',
    'Thiết bị và Worker',
    !s.deviceList ? 'warning' : d.offline > 0 || d.withWarnings > 0 ? 'warning' : 'ok',
    !s.deviceList
      ? 'Không đọc được danh sách thiết bị'
      : d.total === 0
        ? 'Chưa có thiết bị'
        : `${d.online}/${d.total} trực tuyến${d.offline > 0 ? `, ${d.offline} mất kết nối` : ''}${d.withWarnings > 0 ? `, ${d.withWarnings} có cảnh báo` : ''}`,
  );
  return out;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec} giây`;
  if (sec < 3600) return `${Math.floor(sec / 60)} phút`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} giờ ${Math.floor((sec % 3600) / 60)} phút`;
  return `${Math.floor(sec / 86_400)} ngày ${Math.floor((sec % 86_400) / 3600)} giờ`;
}
