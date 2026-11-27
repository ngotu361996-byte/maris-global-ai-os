'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  DEVICE_KIND_LABEL,
  DEVICE_KINDS,
  DEVICE_STATUS_LABEL,
  type DeviceEventResponse,
  type DeviceKind,
  type DeviceMetricResponse,
  type DevicePairingResponse,
  type DeviceResponse,
  type ServerStatusResponse,
  WORKER_JOB_KIND_INFO,
  type WorkerJobKind,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api, API_URL } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const REFRESH_MS = 15_000;

const pct = (a: number | null | undefined, b: number | null | undefined) =>
  a !== null && a !== undefined && b ? Math.round((a / b) * 100) : null;
const gb = (mb: number | null | undefined) =>
  mb === null || mb === undefined ? '–' : `${(mb / 1024).toFixed(1)} GB`;

function ago(iso: string | null): string {
  if (!iso) return 'chưa bao giờ';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < 86400) return `${Math.round(s / 3600)} giờ trước`;
  return new Date(iso).toLocaleString('vi-VN');
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} ngày ${h} giờ` : h ? `${h} giờ ${m} phút` : `${m} phút`;
}

function Bar({ value, warnAt = 90 }: { value: number | null; warnAt?: number }) {
  if (value === null) return <span className="text-muted">–</span>;
  const color =
    value >= warnAt ? 'bg-danger' : value >= warnAt - 20 ? 'bg-yellow-500' : 'bg-green-600';
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-2 w-16 overflow-hidden rounded bg-line">
        <span className={`block h-2 ${color}`} style={{ width: `${Math.min(100, value)}%` }} />
      </span>
      <span className="tabular-nums">{Math.round(value)}%</span>
    </span>
  );
}

function Dot({ d }: { d: DeviceResponse }) {
  const [cls, label] =
    d.status === 'revoked'
      ? ['bg-line', 'Đã thu hồi']
      : d.online
        ? d.status === 'paused'
          ? ['bg-yellow-500', 'Trực tuyến, tạm dừng']
          : ['bg-green-500', 'Trực tuyến']
        : d.status === 'pending'
          ? ['bg-line', 'Chờ ghép nối']
          : ['bg-danger', 'Ngoại tuyến'];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} />
      {label}
    </span>
  );
}

/** One line of percentages over time, 0 to 100. */
function Chart({ title, points }: { title: string; points: (number | null)[] }) {
  const w = 300;
  const h = 60;
  const vals = points
    .map((p, i) => (p === null ? null : ([i, p] as const)))
    .filter((p) => p !== null);
  const last = [...points].reverse().find((p) => p !== null);
  const path = vals
    .map(
      ([i, v], k) =>
        `${k ? 'L' : 'M'}${points.length > 1 ? (i / (points.length - 1)) * w : 0},${h - (Math.min(100, v) / 100) * h}`,
    )
    .join(' ');
  return (
    <div className="rounded-md border border-line p-2">
      <div className="mb-1 flex justify-between text-xs text-muted">
        <span>{title}</span>
        <span className="tabular-nums">
          {last === undefined || last === null ? '–' : `${Math.round(last)}%`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="h-14 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={title}
      >
        <line
          x1="0"
          x2={w}
          y1={h * 0.1}
          y2={h * 0.1}
          className="stroke-line"
          strokeDasharray="4 4"
        />
        {path && (
          <path
            d={path}
            fill="none"
            className="stroke-accent"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}

export default function InfraPage() {
  const me = useMe();
  const [items, setItems] = useState<DeviceResponse[]>([]);
  const [server, setServer] = useState<ServerStatusResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<DeviceMetricResponse[]>([]);
  const [events, setEvents] = useState<DeviceEventResponse[]>([]);
  const [pairing, setPairing] = useState<DevicePairingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const load = useCallback(() => {
    api<DeviceResponse[]>('/devices').then(setItems).catch(fail);
    api<ServerStatusResponse>('/devices/server')
      .then(setServer)
      .catch(() => setServer(null));
  }, []);

  const loadDetail = useCallback((id: string) => {
    api<DeviceMetricResponse[]>(`/devices/${id}/metrics?minutes=60`).then(setMetrics).catch(fail);
    api<DeviceEventResponse[]>(`/devices/${id}/events`).then(setEvents).catch(fail);
  }, []);

  useEffect(() => {
    if (!me) return;
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [me, load]);

  useEffect(() => {
    if (!selected) return;
    loadDetail(selected);
    const t = setInterval(() => loadDetail(selected), REFRESH_MS);
    return () => clearInterval(t);
  }, [selected, loadDetail]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const r = await api<DevicePairingResponse>('/devices', {
        method: 'POST',
        body: JSON.stringify({
          name: String(f.get('name')).trim(),
          kind: String(f.get('kind')) as DeviceKind,
        }),
      });
      form.reset();
      setPairing(r);
      setSelected(r.device.id);
      load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function setMaxJobs(d: DeviceResponse, maxJobs: number) {
    setError(null);
    setOk(null);
    try {
      await api(`/devices/${d.id}`, { method: 'PATCH', body: JSON.stringify({ maxJobs }) });
      setOk(
        maxJobs === 0
          ? `“${d.name}” sẽ không nhận việc mới.`
          : `“${d.name}” nhận tối đa ${maxJobs} việc cùng lúc.`,
      );
      load();
    } catch (err) {
      fail(err);
    }
  }

  async function act(
    d: DeviceResponse,
    action: 'pause' | 'resume' | 'revoke' | 'pairing' | 'delete',
  ) {
    const confirmText: Partial<Record<typeof action, string>> = {
      revoke: `Thu hồi khóa của “${d.name}”? Worker trên máy đó ngừng kết nối ngay và không ghép nối lại được.`,
      delete: `Xóa “${d.name}” khỏi danh sách? Lịch sử chỉ số sẽ không còn hiển thị.`,
      pairing: d.pairedAt
        ? `Tạo chuỗi ghép nối mới cho “${d.name}”? Khi Worker dùng chuỗi mới, khóa cũ hết hiệu lực.`
        : undefined,
    };
    const text = confirmText[action];
    if (text && !confirm(text)) return;
    setError(null);
    setOk(null);
    try {
      if (action === 'delete') {
        await api(`/devices/${d.id}`, { method: 'DELETE' });
        setSelected(null);
        setOk(`Đã xóa “${d.name}”.`);
      } else if (action === 'pairing') {
        setPairing(
          await api<DevicePairingResponse>(`/devices/${d.id}/pairing`, { method: 'POST' }),
        );
      } else {
        await api(`/devices/${d.id}/${action}`, { method: 'POST' });
        setOk(
          action === 'pause'
            ? `Đã tạm dừng “${d.name}”.`
            : action === 'resume'
              ? `Đã chạy lại “${d.name}”.`
              : `Đã thu hồi “${d.name}”.`,
        );
      }
      load();
      if (action !== 'delete') loadDetail(d.id);
    } catch (err) {
      fail(err);
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const current = items.find((d) => d.id === selected) ?? null;
  const origin = API_URL.replace(/\/api\/v1\/?$/, '');
  const online = items.filter((d) => d.online).length;
  const warned = items.filter((d) => d.warnings.length > 0).length;

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Hạ tầng</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Máy chủ MARIS và các máy chạy Worker: VPS, máy quản trị, máy GPU. Worker trên mỗi máy tự kết
        nối ra MARIS và báo CPU, RAM, ổ đĩa, GPU mỗi 15 giây. MARIS không mở kết nối vào máy của bạn
        và không chạy lệnh trên đó.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        {[
          ['Thiết bị', String(items.length)],
          ['Trực tuyến', `${online}/${items.filter((d) => d.status !== 'revoked').length}`],
          ['Có cảnh báo', String(warned)],
          [
            'GPU đang báo',
            String(items.reduce((n, d) => n + (d.online ? (d.latest?.gpus.length ?? 0) : 0), 0)),
          ],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line bg-panel p-3">
            <div className="text-xs text-muted">{k}</div>
            <div className="text-2xl font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      {server && (
        <Panel title={`Máy chủ MARIS: ${server.hostname}`}>
          <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <span className="text-muted">CPU ({server.cpuCores} nhân): </span>
              <Bar value={server.cpuPct} />
            </div>
            <div>
              <span className="text-muted">RAM: </span>
              <Bar value={pct(server.ramUsedMb, server.ramTotalMb)} warnAt={95} />{' '}
              <span className="text-muted">của {gb(server.ramTotalMb)}</span>
            </div>
            <div>
              <span className="text-muted">Ổ đĩa: </span>
              <Bar value={pct(server.diskUsedGb, server.diskTotalGb)} />{' '}
              {server.diskTotalGb !== null && (
                <span className="text-muted">của {Math.round(server.diskTotalGb)} GB</span>
              )}
            </div>
            <div className="text-muted">{server.os}</div>
            <div className="text-muted">Đã chạy {uptime(server.uptimeSec)}</div>
            {server.loadAvg.some((x) => x > 0) && (
              <div className="text-muted">Tải: {server.loadAvg.join(' / ')}</div>
            )}
          </div>
        </Panel>
      )}

      {pairing && (
        <section className="mb-6 rounded-lg border border-accent bg-panel p-4">
          <h2 className="mb-2 text-sm font-semibold">Chuỗi ghép nối cho “{pairing.device.name}”</h2>
          <p className="mb-3 text-sm text-muted">
            Chuỗi chỉ hiện một lần, dùng được một lần, hết hạn lúc{' '}
            {new Date(pairing.expiresAt).toLocaleTimeString('vi-VN')}. Trên máy cần ghép nối, mở thư
            mục MARIS trong Windows PowerShell rồi chạy lần lượt:
          </p>
          <pre className="mb-2 overflow-x-auto rounded-md border border-line bg-bg p-2 text-xs">
            pnpm worker pair &quot;{pairing.pairing}&quot; --server {origin}
          </pre>
          <pre className="mb-3 overflow-x-auto rounded-md border border-line bg-bg p-2 text-xs">
            pnpm worker run
          </pre>
          <div className="flex gap-2">
            <button
              className={btnGhostCls}
              onClick={() =>
                navigator.clipboard?.writeText(
                  `pnpm worker pair "${pairing.pairing}" --server ${origin}`,
                )
              }
            >
              Sao chép lệnh ghép nối
            </button>
            <button className={btnGhostCls} onClick={() => setPairing(null)}>
              Đã xong, ẩn chuỗi
            </button>
          </div>
        </section>
      )}

      <Panel title="Thêm thiết bị">
        <form onSubmit={create} className="flex flex-wrap items-end gap-3" autoComplete="off">
          <label className="text-sm">
            Tên
            <input
              name="name"
              required
              maxLength={80}
              placeholder="Máy GPU phòng kỹ thuật"
              className={`${inputCls} mt-1 w-64`}
            />
          </label>
          <label className="text-sm">
            Loại
            <select name="kind" defaultValue="gpu_worker" className={`${inputCls} mt-1 w-56`}>
              {DEVICE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {DEVICE_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <button disabled={busy} className={btnCls}>
            {busy ? 'Đang tạo…' : 'Tạo và lấy chuỗi ghép nối'}
          </button>
        </form>
      </Panel>

      <Panel title={`Thiết bị (${items.length})`}>
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            Chưa có thiết bị nào. Thêm một thiết bị ở trên để lấy chuỗi ghép nối.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">Tên</th>
                  <th>Trạng thái</th>
                  <th>CPU</th>
                  <th>RAM</th>
                  <th>Ổ đĩa</th>
                  <th>GPU</th>
                  <th>Việc</th>
                  <th>Lần báo cuối</th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => {
                  const m = d.online ? d.latest : null;
                  const g = m?.gpus[0];
                  return (
                    <tr
                      key={d.id}
                      onClick={() => setSelected(d.id === selected ? null : d.id)}
                      className={`cursor-pointer border-t border-line align-top ${d.id === selected ? 'bg-bg' : ''}`}
                    >
                      <td className="py-2 pr-3">
                        <div className="font-medium">{d.name}</div>
                        <div className="text-xs text-muted">{DEVICE_KIND_LABEL[d.kind]}</div>
                        {d.warnings.map((w) => (
                          <div key={w} className="text-xs text-danger">
                            ⚠ {w}
                          </div>
                        ))}
                      </td>
                      <td className="py-2 pr-3">
                        <Dot d={d} />
                        {d.status === 'paused' && !d.online && (
                          <div className="text-xs text-muted">Tạm dừng</div>
                        )}
                      </td>
                      <td className="py-2 pr-3">{m ? <Bar value={m.cpuPct} /> : '–'}</td>
                      <td className="py-2 pr-3">
                        {m ? <Bar value={pct(m.ramUsedMb, m.ramTotalMb)} warnAt={95} /> : '–'}
                      </td>
                      <td className="py-2 pr-3">
                        {m ? <Bar value={pct(m.diskUsedGb, m.diskTotalGb)} /> : '–'}
                      </td>
                      <td className="py-2 pr-3">
                        {g ? (
                          <span className="text-xs">
                            {m!.gpus.length > 1 ? `${m!.gpus.length}× ` : ''}
                            {g.utilPct ?? '–'}% · {g.tempC ?? '–'}°C
                          </span>
                        ) : (
                          '–'
                        )}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">
                        {d.pairedAt ? `${d.runningJobs}/${d.maxJobs}` : '–'}
                      </td>
                      <td className="py-2 text-muted whitespace-nowrap">{ago(d.lastSeenAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {current && (
        <Panel title={`Chi tiết: ${current.name}`}>
          <div className="mb-4 flex flex-wrap gap-2">
            {current.status === 'active' && (
              <button className={btnGhostCls} onClick={() => act(current, 'pause')}>
                Tạm dừng
              </button>
            )}
            {current.status === 'paused' && (
              <button className={btnGhostCls} onClick={() => act(current, 'resume')}>
                Chạy lại
              </button>
            )}
            {current.status !== 'revoked' && (
              <>
                <button className={btnGhostCls} onClick={() => act(current, 'pairing')}>
                  Tạo chuỗi ghép nối mới
                </button>
                <button
                  className={`${btnGhostCls} border-danger text-danger`}
                  onClick={() => act(current, 'revoke')}
                >
                  Thu hồi khóa
                </button>
              </>
            )}
            <button
              className={`${btnGhostCls} border-danger text-danger`}
              onClick={() => act(current, 'delete')}
            >
              Xóa
            </button>
          </div>

          {current.status !== 'revoked' && (
            <label className="mb-4 flex items-center gap-2 text-sm">
              <span className="text-muted">Số việc chạy cùng lúc:</span>
              <select
                value={current.maxJobs}
                onChange={(e) => setMaxJobs(current, Number(e.target.value))}
                className={`${inputCls} w-auto py-1`}
              >
                {[0, 1, 2, 3, 4, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? '0 (không nhận việc)' : n}
                  </option>
                ))}
              </select>
            </label>
          )}

          <dl className="mb-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {[
              ['Trạng thái', DEVICE_STATUS_LABEL[current.status]],
              ['Tên máy', current.info.hostname],
              [
                'Hệ điều hành',
                current.info.os && `${current.info.os} (${current.info.arch ?? ''})`,
              ],
              [
                'CPU',
                current.info.cpuModel && `${current.info.cpuModel}, ${current.info.cpuCores} nhân`,
              ],
              ['RAM', current.info.ramTotalMb ? gb(current.info.ramTotalMb) : undefined],
              [
                'GPU',
                current.info.gpus?.length
                  ? current.info.gpus.map((g) => g.name).join(', ')
                  : current.pairedAt
                    ? 'Không có GPU NVIDIA'
                    : undefined,
              ],
              ['Phiên bản Worker', current.info.agentVersion],
              [
                'Nhận việc',
                current.pairedAt &&
                  (current.capabilities.length
                    ? current.capabilities
                        .map((k) => WORKER_JOB_KIND_INFO[k as WorkerJobKind]?.label ?? k)
                        .join(', ')
                    : 'Không (chỉ báo cáo tài nguyên)'),
              ],
              ['Địa chỉ IP gần nhất', current.lastIp],
              [
                'Ghép nối lúc',
                current.pairedAt && new Date(current.pairedAt).toLocaleString('vi-VN'),
              ],
              [
                'Chuỗi ghép nối đang chờ',
                current.pairingExpiresAt &&
                  `hết hạn ${new Date(current.pairingExpiresAt).toLocaleTimeString('vi-VN')}`,
              ],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="text-muted">{k}:</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>

          {metrics.length > 0 ? (
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Chart title="CPU, 60 phút" points={metrics.map((m) => m.cpuPct)} />
              <Chart title="RAM" points={metrics.map((m) => pct(m.ramUsedMb, m.ramTotalMb))} />
              <Chart title="Ổ đĩa" points={metrics.map((m) => pct(m.diskUsedGb, m.diskTotalGb))} />
              {(metrics.at(-1)?.gpus ?? []).map((g) => (
                <Chart
                  key={g.index}
                  title={`GPU ${g.index}: ${g.name}`}
                  points={metrics.map(
                    (m) => m.gpus.find((x) => x.index === g.index)?.utilPct ?? null,
                  )}
                />
              ))}
            </div>
          ) : (
            <p className="mb-4 text-sm text-muted">Chưa có chỉ số trong 60 phút qua.</p>
          )}

          <h3 className="mb-2 text-xs font-semibold text-muted">Sự kiện gần đây</h3>
          {events.length === 0 ? (
            <p className="text-sm text-muted">Chưa có sự kiện.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {events.slice(0, 30).map((e) => (
                <li key={e.id} className="flex gap-3">
                  <span className="w-36 shrink-0 text-muted">
                    {new Date(e.createdAt).toLocaleString('vi-VN')}
                  </span>
                  <span className={e.level === 'info' ? '' : 'text-danger'}>{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </Shell>
  );
}
