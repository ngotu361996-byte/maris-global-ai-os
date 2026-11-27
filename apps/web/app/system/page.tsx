'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CHECK_STATUS_LABEL,
  MONITOR_REFRESH_SEC,
  type CheckStatus,
  type SystemMonitorResponse,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnGhostCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const DOT: Record<CheckStatus, string> = {
  ok: 'bg-green-500',
  warning: 'bg-yellow-500',
  error: 'bg-danger',
};
const TEXT: Record<CheckStatus, string> = {
  ok: 'text-green-500',
  warning: 'text-yellow-500',
  error: 'text-danger',
};
const SOURCE_LABEL: Record<SystemMonitorResponse['recentErrors'][number]['source'], string> = {
  ai: 'Gọi AI',
  task: 'Việc AI',
  workflow: 'Workflow',
  connector: 'Connector',
  worker_job: 'Việc Worker',
};

function duration(sec: number) {
  if (sec < 60) return `${sec} giây`;
  if (sec < 3600) return `${Math.floor(sec / 60)} phút`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} giờ ${Math.floor((sec % 3600) / 60)} phút`;
  return `${Math.floor(sec / 86_400)} ngày ${Math.floor((sec % 86_400) / 3600)} giờ`;
}

function Stat({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <div className="rounded-md border border-line bg-bg p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${warn ? 'text-yellow-500' : ''}`}>
        {value}
      </div>
    </div>
  );
}

export default function SystemMonitorPage() {
  const me = useMe();
  const [data, setData] = useState<SystemMonitorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<SystemMonitorResponse>('/system/monitor')
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) =>
        setError(
          e instanceof Error
            ? `${e.message}. Nếu không mở được trang, có thể chính máy chủ API đang dừng.`
            : 'Lỗi',
        ),
      );
  }, []);
  useEffect(() => {
    if (!me) return;
    load();
    const t = setInterval(load, MONITOR_REFRESH_SEC * 1000);
    return () => clearInterval(t);
  }, [me, load]);

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const a = data?.activity;

  return (
    <Shell me={me}>
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Giám sát hệ thống</h1>
        {data && (
          <span
            className={`rounded border px-2 py-0.5 text-sm ${TEXT[data.status]} border-current`}
          >
            {CHECK_STATUS_LABEL[data.status]}
          </span>
        )}
        <button className={btnGhostCls} onClick={load}>
          Làm mới
        </button>
      </div>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Tình trạng máy chủ API, cơ sở dữ liệu, Redis, hàng đợi, Worker và lỗi trong 24 giờ qua. Tự
        làm mới mỗi {MONITOR_REFRESH_SEC} giây
        {data ? `, lần cuối ${new Date(data.checkedAt).toLocaleTimeString('vi-VN')}` : ''}.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {!data && !error && <p className="text-sm text-muted">Đang kiểm tra…</p>}

      {data && a && (
        <>
          <Panel title="Kiểm tra">
            <ul className="grid gap-2 sm:grid-cols-2">
              {data.checks.map((c) => (
                <li key={c.key} className="flex gap-3 rounded-md border border-line bg-bg p-3">
                  <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[c.status]}`} />
                  <div>
                    <div className="text-sm font-medium">
                      {c.label}{' '}
                      <span className={`text-xs ${TEXT[c.status]}`}>
                        {CHECK_STATUS_LABEL[c.status]}
                      </span>
                    </div>
                    <div className="text-xs text-muted">{c.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Hoạt động 24 giờ qua">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Lượt gọi AI" value={a.aiCalls24h} />
              <Stat label="Lượt gọi AI lỗi" value={a.aiErrors24h} warn={a.aiErrors24h > 0} />
              <Stat
                label="Độ trễ AI trung bình"
                value={
                  a.aiAvgLatencyMs24h === null
                    ? '–'
                    : `${(a.aiAvgLatencyMs24h / 1000).toFixed(1)} s`
                }
              />
              <Stat label="Việc AI lỗi" value={a.tasksFailed24h} warn={a.tasksFailed24h > 0} />
              <Stat
                label="Workflow lỗi"
                value={a.workflowRunsFailed24h}
                warn={a.workflowRunsFailed24h > 0}
              />
              <Stat label="Workflow chờ duyệt" value={a.workflowRunsWaitingApproval} />
              <Stat
                label="Connector lỗi"
                value={a.connectorCallsFailed24h}
                warn={a.connectorCallsFailed24h > 0}
              />
              <Stat
                label="Việc Worker (chờ / chạy / lỗi)"
                value={`${a.workerJobsQueued} / ${a.workerJobsRunning} / ${a.workerJobsFailed24h}`}
                warn={a.workerJobsFailed24h > 0}
              />
            </div>
          </Panel>

          <div className="grid gap-x-6 lg:grid-cols-2">
            <Panel title="Máy chủ">
              <dl className="grid gap-y-1 text-sm">
                {[
                  ['API', `chạy ${duration(data.api.uptimeSec)}, Node ${data.api.nodeVersion}`],
                  [
                    'Bộ nhớ API',
                    `${data.api.rssMb} MB (heap ${data.api.heapUsedMb}/${data.api.heapLimitMb} MB)`,
                  ],
                  [
                    'PostgreSQL',
                    data.database.up
                      ? `${data.database.version ?? ''}, ${data.database.latencyMs} ms, ${data.database.sizeMb ?? '?'} MB, ${data.database.connections ?? '?'} kết nối`
                      : 'không kết nối được',
                  ],
                  [
                    'Redis',
                    data.redis.up
                      ? `${data.redis.version ?? ''}, ${data.redis.latencyMs} ms, ${data.redis.usedMemoryMb ?? '?'} MB`
                      : 'không kết nối được',
                  ],
                  [
                    'Sự kiện chờ phát',
                    data.outbox.pending === 0
                      ? 'không có'
                      : `${data.outbox.pending}, cũ nhất ${duration(data.outbox.oldestPendingSec ?? 0)}`,
                  ],
                  [
                    'Thiết bị',
                    `${data.devices.online}/${data.devices.total} trực tuyến, ${data.devices.offline} mất kết nối, ${data.devices.withWarnings} có cảnh báo`,
                  ],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <dt className="w-36 shrink-0 text-muted">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </Panel>

            <Panel title="Hàng đợi">
              {data.queues.length === 0 ? (
                <p className="text-sm text-muted">Không đọc được hàng đợi.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr>
                      <th className="py-1">Hàng đợi</th>
                      <th className="text-right">Chờ</th>
                      <th className="text-right">Đang chạy</th>
                      <th className="text-right">Hẹn giờ</th>
                      <th className="text-right">Lỗi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.queues.map((q) => (
                      <tr key={q.name} className="border-t border-line tabular-nums">
                        <td className="py-1.5">{q.label}</td>
                        <td className="text-right">{q.waiting}</td>
                        <td className="text-right">{q.active}</td>
                        <td className="text-right">{q.delayed}</td>
                        <td className={`text-right ${q.failed > 0 ? 'text-yellow-500' : ''}`}>
                          {q.failed}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>

          <Panel title="Lỗi gần đây">
            {data.recentErrors.length === 0 ? (
              <p className="text-sm text-muted">Không có lỗi nào.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {data.recentErrors.map((e, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-32 shrink-0 text-muted">
                      {new Date(e.at).toLocaleString('vi-VN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        day: '2-digit',
                        month: '2-digit',
                      })}
                    </span>
                    <span className="w-24 shrink-0 text-muted">{SOURCE_LABEL[e.source]}</span>
                    <span className="break-all">{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </Shell>
  );
}
