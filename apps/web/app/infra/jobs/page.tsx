'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  DEVICE_KIND_LABEL,
  WORKER_JOB_KIND_INFO,
  WORKER_JOB_KINDS,
  WORKER_JOB_STATUS_LABEL,
  type DeviceResponse,
  type WorkerJobKind,
  type WorkerJobLogResponse,
  type WorkerJobResponse,
  type WorkerJobStatus,
} from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

type JobDetail = WorkerJobResponse & { logs: WorkerJobLogResponse[] };

const STATUS_CLS: Record<WorkerJobStatus, string> = {
  queued: 'border-line text-muted',
  running: 'border-accent text-accent',
  completed: 'border-green-600 text-green-500',
  failed: 'border-danger text-danger',
  cancelled: 'border-line text-muted',
};

function Status({ s }: { s: WorkerJobStatus }) {
  return (
    <span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-xs ${STATUS_CLS[s]}`}>
      {WORKER_JOB_STATUS_LABEL[s]}
    </span>
  );
}

function time(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString('vi-VN') : '–';
}

function Result({ job }: { job: JobDetail }) {
  if (job.result === null || job.result === undefined) return null;
  const r = job.result as Record<string, unknown>;
  if (job.kind === 'ollama.generate' && typeof r.response === 'string')
    return (
      <div className="mb-3">
        <div className="mb-1 text-xs text-muted">
          Trả lời của {String(r.model)}
          {r.outputTokens ? `, ${String(r.outputTokens)} token` : ''}
          {r.durationMs ? `, ${Math.round(Number(r.durationMs) / 100) / 10} giây` : ''}
        </div>
        <div className="whitespace-pre-wrap rounded-md border border-line bg-bg p-2 text-sm">
          {r.response}
        </div>
      </div>
    );
  return (
    <div className="mb-3">
      <div className="mb-1 text-xs text-muted">Kết quả</div>
      <pre className="max-h-80 overflow-auto rounded-md border border-line bg-bg p-2 text-xs">
        {JSON.stringify(job.result, null, 2)}
      </pre>
    </div>
  );
}

export default function WorkerJobsPage() {
  const me = useMe();
  const [jobs, setJobs] = useState<WorkerJobResponse[]>([]);
  const [devices, setDevices] = useState<DeviceResponse[]>([]);
  const [filter, setFilter] = useState<WorkerJobStatus | ''>('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [kind, setKind] = useState<WorkerJobKind>('diagnostics');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định');

  const load = useCallback(() => {
    api<WorkerJobResponse[]>(`/worker-jobs?limit=100${filter ? `&status=${filter}` : ''}`)
      .then(setJobs)
      .catch(fail);
    api<DeviceResponse[]>('/devices')
      .then(setDevices)
      .catch(() => {});
  }, [filter]);
  const loadDetail = useCallback((id: string) => {
    api<JobDetail>(`/worker-jobs/${id}`).then(setDetail).catch(fail);
  }, []);

  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!me) return;
    load();
    const t = setInterval(load, active ? 3000 : 10_000);
    return () => clearInterval(t);
  }, [me, load, active]);
  useEffect(() => {
    if (!selected) return setDetail(null);
    loadDetail(selected);
    const t = setInterval(() => loadDetail(selected), 3000);
    return () => clearInterval(t);
  }, [selected, loadDetail]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const input: Record<string, unknown> =
      kind === 'test.wait'
        ? { seconds: Number(f.get('seconds')), fail: f.get('fail') === 'on' }
        : kind === 'ollama.generate'
          ? {
              model: String(f.get('model')).trim(),
              prompt: String(f.get('prompt')),
              maxTokens: Number(f.get('maxTokens')),
            }
          : {};
    const target = String(f.get('target'));
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const j = await api<WorkerJobResponse>('/worker-jobs', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          input,
          title: String(f.get('title') ?? '').trim() || undefined,
          priority: Number(f.get('priority')),
          targetDeviceId: target.startsWith('device:') ? target.slice(7) : null,
          targetKinds: target.startsWith('kind:') ? [target.slice(5)] : [],
          needGpu: f.get('needGpu') === 'on',
        }),
      });
      setOk(`Đã giao “${j.title}”. Worker phù hợp sẽ nhận trong vài giây.`);
      setSelected(j.id);
      load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function act(j: WorkerJobResponse, action: 'cancel' | 'reassign' | 'retry') {
    if (action === 'cancel' && !confirm(`Hủy “${j.title}”?`)) return;
    if (
      action === 'reassign' &&
      !confirm(`Chuyển “${j.title}” khỏi ${j.deviceName ?? 'máy đang chạy'} sang Worker khác?`)
    )
      return;
    setError(null);
    setOk(null);
    try {
      const r = await api<WorkerJobResponse>(`/worker-jobs/${j.id}/${action}`, { method: 'POST' });
      if (action === 'retry') setSelected(r.id);
      setOk(
        action === 'cancel'
          ? 'Đã yêu cầu hủy.'
          : action === 'reassign'
            ? 'Đã đưa việc về hàng đợi cho Worker khác.'
            : 'Đã giao lại việc.',
      );
      load();
      if (action !== 'retry') loadDetail(j.id);
    } catch (err) {
      fail(err);
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const usable = devices.filter((d) => d.status !== 'revoked');
  const ready = usable.filter((d) => d.online && d.status === 'active' && d.maxJobs > 0);
  const canRun = (k: WorkerJobKind) => ready.filter((d) => d.capabilities.includes(k));

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Việc của Worker</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Giao việc cho các máy chạy Worker. Máy trực tuyến, đang hoạt động, còn chỗ trống và đủ RAM,
        ổ đĩa sẽ tự nhận việc. Máy mất kết nối quá 60 giây thì việc tự chuyển sang máy khác. Worker
        chỉ làm các loại việc có sẵn trong chương trình, không chạy lệnh tùy ý.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {ok && <Notice kind="ok">{ok}</Notice>}

      <Panel title="Giao việc">
        <form onSubmit={create} className="grid max-w-3xl gap-3" autoComplete="off">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Loại việc
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as WorkerJobKind)}
                className={`${inputCls} mt-1`}
              >
                {WORKER_JOB_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {WORKER_JOB_KIND_INFO[k].label} ({canRun(k).length} máy sẵn sàng)
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Tên việc (không bắt buộc)
              <input
                name="title"
                maxLength={120}
                placeholder={WORKER_JOB_KIND_INFO[kind].label}
                className={`${inputCls} mt-1`}
              />
            </label>
          </div>
          <p className="text-xs text-muted">{WORKER_JOB_KIND_INFO[kind].description}</p>

          {kind === 'test.wait' && (
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-sm">
                Số giây
                <input
                  name="seconds"
                  type="number"
                  min={1}
                  max={600}
                  defaultValue={30}
                  className={`${inputCls} mt-1 w-28`}
                />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input name="fail" type="checkbox" /> Báo lỗi ở cuối (để thử)
              </label>
            </div>
          )}
          {kind === 'ollama.generate' && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  Model
                  <input
                    name="model"
                    required
                    placeholder="llama3.2"
                    className={`${inputCls} mt-1`}
                  />
                </label>
                <label className="text-sm">
                  Token tối đa
                  <input
                    name="maxTokens"
                    type="number"
                    min={1}
                    max={8192}
                    defaultValue={512}
                    className={`${inputCls} mt-1`}
                  />
                </label>
              </div>
              <label className="text-sm">
                Yêu cầu
                <textarea
                  name="prompt"
                  required
                  rows={3}
                  maxLength={20000}
                  className={`${inputCls} mt-1`}
                />
              </label>
              {canRun('ollama.generate').length === 0 && (
                <p className="text-xs text-muted">
                  Chưa máy nào báo có Ollama. Cài Ollama (ollama.com), tải một model (ví dụ{' '}
                  <code>ollama pull llama3.2</code>) trên máy chạy Worker; Worker tự nhận ra trong
                  vòng 5 phút.
                </p>
              )}
            </>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              Chạy trên
              <select name="target" defaultValue="" className={`${inputCls} mt-1`}>
                <option value="">Máy bất kỳ phù hợp</option>
                <optgroup label="Theo loại máy">
                  {[...new Set(usable.map((d) => d.kind))].map((k) => (
                    <option key={k} value={`kind:${k}`}>
                      {DEVICE_KIND_LABEL[k]}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Máy cụ thể">
                  {usable.map((d) => (
                    <option key={d.id} value={`device:${d.id}`}>
                      {d.name}
                      {d.online ? '' : ' (ngoại tuyến)'}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="text-sm">
              Ưu tiên
              <select name="priority" defaultValue="0" className={`${inputCls} mt-1`}>
                <option value="5">Cao</option>
                <option value="0">Thường</option>
                <option value="-5">Thấp</option>
              </select>
            </label>
            <label className="mt-6 flex items-center gap-2 text-sm">
              <input name="needGpu" type="checkbox" /> Cần GPU
            </label>
          </div>
          <div>
            <button disabled={busy} className={btnCls}>
              {busy ? 'Đang giao…' : 'Giao việc'}
            </button>
          </div>
        </form>
      </Panel>

      <Panel title={`Danh sách việc (${jobs.length})`}>
        <div className="mb-3 flex flex-wrap gap-2">
          {(['', 'queued', 'running', 'completed', 'failed', 'cancelled'] as const).map((s) => (
            <button
              key={s || 'all'}
              onClick={() => setFilter(s)}
              className={`${btnGhostCls} ${filter === s ? 'border-accent text-accent' : ''}`}
            >
              {s ? WORKER_JOB_STATUS_LABEL[s] : 'Tất cả'}
            </button>
          ))}
        </div>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted">Chưa có việc nào.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1">Việc</th>
                  <th>Trạng thái</th>
                  <th>Tiến độ</th>
                  <th>Máy</th>
                  <th>Lần thử</th>
                  <th>Giao lúc</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr
                    key={j.id}
                    onClick={() => setSelected(j.id === selected ? null : j.id)}
                    className={`cursor-pointer border-t border-line align-top ${j.id === selected ? 'bg-bg' : ''}`}
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium">{j.title}</div>
                      <div className="text-xs text-muted">
                        {WORKER_JOB_KIND_INFO[j.kind].label}
                        {j.priority > 0
                          ? ' · ưu tiên cao'
                          : j.priority < 0
                            ? ' · ưu tiên thấp'
                            : ''}
                        {j.needGpu ? ' · cần GPU' : ''}
                      </div>
                      {j.errorMessage && (
                        <div className="text-xs text-danger">{j.errorMessage}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Status s={j.status} />
                      {j.cancelRequested && j.status === 'running' && (
                        <div className="text-xs text-muted">đang hủy</div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="inline-flex items-center gap-2">
                        <span className="inline-block h-2 w-20 overflow-hidden rounded bg-line">
                          <span
                            className="block h-2 bg-accent"
                            style={{ width: `${j.progress}%` }}
                          />
                        </span>
                        <span className="tabular-nums">{j.progress}%</span>
                      </span>
                      {j.progressNote && j.status === 'running' && (
                        <div className="text-xs text-muted">{j.progressNote}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {j.deviceName ?? <span className="text-muted">–</span>}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {j.attempts}/{j.maxAttempts}
                    </td>
                    <td className="whitespace-nowrap py-2 text-muted">{time(j.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {detail && (
        <Panel title={`Chi tiết: ${detail.title}`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Status s={detail.status} />
            {(detail.status === 'queued' || detail.status === 'running') &&
              !detail.cancelRequested && (
                <button
                  className={`${btnGhostCls} border-danger text-danger`}
                  onClick={() => act(detail, 'cancel')}
                >
                  Hủy
                </button>
              )}
            {detail.status === 'running' && (
              <button className={btnGhostCls} onClick={() => act(detail, 'reassign')}>
                Chuyển sang máy khác
              </button>
            )}
            {(detail.status === 'failed' ||
              detail.status === 'cancelled' ||
              detail.status === 'completed') && (
              <button className={btnGhostCls} onClick={() => act(detail, 'retry')}>
                Giao lại
              </button>
            )}
          </div>
          <dl className="mb-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {[
              ['Loại', WORKER_JOB_KIND_INFO[detail.kind].label],
              ['Máy đang hoặc đã chạy', detail.deviceName],
              ['Bắt đầu', detail.startedAt && new Date(detail.startedAt).toLocaleString('vi-VN')],
              [
                'Kết thúc',
                detail.finishedAt && new Date(detail.finishedAt).toLocaleString('vi-VN'),
              ],
              ['Giới hạn thời gian', `${detail.timeoutSec} giây`],
              ['Mã lỗi', detail.errorCode],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <dt className="text-muted">{k}:</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
          {Object.keys(detail.input).length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-xs text-muted">Ô nhập</div>
              <pre className="max-h-40 overflow-auto rounded-md border border-line bg-bg p-2 text-xs">
                {JSON.stringify(detail.input, null, 2)}
              </pre>
            </div>
          )}
          <Result job={detail} />
          <div className="mb-1 text-xs text-muted">Nhật ký</div>
          <ul className="space-y-1 text-sm">
            {detail.logs.map((l) => (
              <li key={l.id} className="flex gap-3">
                <span className="w-20 shrink-0 text-muted">{time(l.createdAt)}</span>
                <span
                  className={
                    l.level === 'error'
                      ? 'text-danger'
                      : l.level === 'warning'
                        ? 'text-yellow-500'
                        : ''
                  }
                >
                  {l.message}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </Shell>
  );
}
