'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  ACCESS_LEVEL_LABEL,
  PLAN_STATUS_LABEL,
  TASK_STATUS_LABEL,
  type AgentResponse,
  type PlanDetailResponse,
  type PlanResponse,
  type PlanStatus,
  type ProjectResponse,
  type TaskResponse,
} from '@maris/contracts';
import { Markdown } from '@/components/Markdown';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const STATUS_COLOR: Partial<Record<PlanStatus, string>> = {
  planning: 'text-accent',
  proposed: 'text-accent',
  accepted: 'text-green-500',
  failed: 'text-danger',
  discarded: 'text-muted',
};
const TASK_COLOR: Partial<Record<TaskResponse['status'], string>> = {
  completed: 'text-green-500',
  failed: 'text-danger',
  rejected: 'text-muted',
  cancelled: 'text-muted',
};
const FINISHED: TaskResponse['status'][] = ['completed', 'failed', 'cancelled', 'rejected'];

const ERROR_TEXT: Record<string, string> = {
  PLAN_INVALID: 'AI không trả về kế hoạch đúng dạng. Thử lại hoặc viết mục tiêu rõ hơn.',
  ALL_PROVIDERS_FAILED: 'Tất cả AI đều lỗi. Kiểm tra key ở mục AI Provider.',
  NO_PROVIDER: 'Chưa có AI nào được bật.',
  EMERGENCY_STOP: 'Bị ngắt do Dừng khẩn cấp.',
  BUDGET_EXCEEDED: 'Đã hết ngân sách AI tháng này.',
};

export default function CommandPage() {
  const me = useMe();
  const [plans, setPlans] = useState<PlanResponse[]>([]);
  const [agents, setAgents] = useState<AgentResponse[]>([]);
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [open, setOpen] = useState<PlanDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<PlanResponse[]>('/ai/plans')
      .then(setPlans)
      .catch((e: Error) => setError(e.message));
  }, []);
  const loadOpen = useCallback((id: string, reveal = false) => {
    api<PlanDetailResponse>(`/ai/plans/${id}`)
      .then((p) => {
        setOpen(p);
        if (reveal) requestAnimationFrame(() => document.getElementById('plan-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!me) return;
    load();
    api<AgentResponse[]>('/ai/agents').then(setAgents).catch(() => undefined);
    api<ProjectResponse[]>('/ai/projects').then(setProjects).catch(() => undefined);
  }, [me, load]);

  // Follow progress while MARIS plans, tasks run or the report is written.
  const openId = open?.id;
  const openLive =
    !!open && (open.status === 'planning' || open.reportStatus === 'running' || (open.status === 'accepted' && open.tasks.some((t) => !FINISHED.includes(t.status))));
  const anyLive = plans.some((p) => p.status === 'planning' || p.reportStatus === 'running');
  useEffect(() => {
    if (!anyLive && !openLive) return;
    const t = setInterval(() => {
      load();
      if (openId) loadOpen(openId);
    }, 2000);
    return () => clearInterval(t);
  }, [anyLive, openLive, openId, load, loadOpen]);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi không xác định');
    } finally {
      setBusy(false);
    }
  }

  function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      const p = await api<PlanResponse>('/ai/plans', {
        method: 'POST',
        body: JSON.stringify({
          goal: String(f.get('goal') ?? '').trim(),
          budgetUsd: Number(f.get('budgetUsd')),
          projectId: String(f.get('projectId') ?? '') || null,
        }),
      });
      form.reset();
      setOk('MARIS đang lập kế hoạch. Kế hoạch hiện bên dưới khi xong.');
      load();
      loadOpen(p.id, true);
    });
  }

  const act = (p: PlanResponse, action: 'accept' | 'discard' | 'report', message: string) =>
    run(async () => {
      if (action === 'discard' && !confirm('Bỏ kế hoạch này?')) return;
      await api(`/ai/plans/${p.id}/${action}`, { method: 'POST', body: '{}' });
      setOk(message);
      load();
      loadOpen(p.id);
    });

  const decide = (t: TaskResponse, action: 'approve' | 'reject') =>
    run(async () => {
      await api(`/ai/tasks/${t.id}/${action}`, { method: 'POST', body: '{}' });
      setOk(action === 'approve' ? `Đã duyệt “${t.title}”. AI bắt đầu làm.` : `Đã từ chối “${t.title}”.`);
      if (open) loadOpen(open.id);
    });

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const agentName = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? 'Agent đã xóa') : 'MARIS tự làm');
  const activeAgents = agents.filter((a) => a.status === 'active').length;

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">AI Tổng điều hành</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Giao cho MARIS một mục tiêu kinh doanh. MARIS lập kế hoạch nhiều bước và giao mỗi bước cho AI Agent phù hợp với mức quyền của Agent. Bạn xem
        lại kế hoạch rồi bấm tạo công việc; mỗi công việc vẫn cần được duyệt trước khi chạy. Khi xong, MARIS tổng hợp báo cáo. Ở giai đoạn này AI chỉ
        soạn văn bản, không tự đăng bài, gửi tin hay chi tiền.
      </p>
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      {open && (
        <div id="plan-detail" className="scroll-mt-4">
          <Panel title="Kế hoạch">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="whitespace-pre-wrap text-sm font-medium">{open.goal}</div>
                <div className="mt-1 text-xs text-muted">
                  <span className={STATUS_COLOR[open.status] ?? ''}>{PLAN_STATUS_LABEL[open.status]}</span> · ngân sách ${open.budgetUsd} · chi phí
                  lập kế hoạch và báo cáo ${open.costUsd.toFixed(4)}
                  {open.errorCode && <span className="text-danger"> · {ERROR_TEXT[open.errorCode] ?? open.errorCode}</span>}
                </div>
              </div>
              <button onClick={() => setOpen(null)} className={btnGhostCls}>
                Đóng
              </button>
            </div>

            {open.status === 'planning' && <p className="text-sm text-muted">MARIS đang phân tích mục tiêu và lập kế hoạch…</p>}
            {open.summary && (
              <div className="mb-3 rounded-md border border-line p-3 text-sm">
                <div className="mb-1 text-xs font-semibold text-muted">Cách tiếp cận</div>
                {open.summary}
              </div>
            )}

            {open.steps.length > 0 && (
              <ol className="mb-3 space-y-2 text-sm">
                {open.steps.map((s, i) => {
                  const task = open.tasks.find((t) => t.stepIndex === i);
                  return (
                    <li key={i} className="rounded-md border border-line p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">
                            {i + 1}. {s.title}
                          </div>
                          <div className="text-xs text-muted">
                            {agentName(s.agentId)} · cần quyền {ACCESS_LEVEL_LABEL[s.requiredLevel]} · ngân sách ${s.budgetUsd}
                          </div>
                        </div>
                        {task && (
                          <div className="flex items-center gap-2 text-xs">
                            <span className={TASK_COLOR[task.status] ?? 'text-accent'}>
                              {TASK_STATUS_LABEL[task.status]}
                            </span>
                            {task.status === 'pending' && (
                              <>
                                <button disabled={busy} onClick={() => decide(task, 'approve')} className={btnGhostCls}>
                                  Duyệt
                                </button>
                                <button disabled={busy} onClick={() => decide(task, 'reject')} className={btnGhostCls}>
                                  Từ chối
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      <details className="mt-1 text-xs text-muted">
                        <summary className="cursor-pointer">Chi tiết</summary>
                        <div className="mt-1 space-y-1 whitespace-pre-wrap">
                          <div>Mục tiêu: {s.goal}</div>
                          <div>Phạm vi: {s.scope}</div>
                          <div>Tiêu chí hoàn thành: {s.successCriteria}</div>
                        </div>
                      </details>
                      {s.note && <div className="mt-1 text-xs text-accent">{s.note}</div>}
                      {task?.result && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-muted">Kết quả (${task.costUsd.toFixed(4)})</summary>
                          <div className="mt-1 text-sm">
                            <Markdown text={task.result} />
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="flex flex-wrap gap-2">
              {open.status === 'proposed' && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => act(open, 'accept', 'Đã tạo các công việc. Duyệt từng việc ở đây hoặc ở trang Giao việc để AI bắt đầu làm.')}
                    className={btnCls}
                  >
                    Tạo {open.steps.length} công việc chờ duyệt
                  </button>
                  <button disabled={busy} onClick={() => act(open, 'discard', 'Đã bỏ kế hoạch.')} className={btnGhostCls}>
                    Bỏ kế hoạch
                  </button>
                </>
              )}
              {open.status === 'failed' && (
                <button disabled={busy} onClick={() => act(open, 'discard', 'Đã bỏ kế hoạch.')} className={btnGhostCls}>
                  Bỏ kế hoạch
                </button>
              )}
              {open.status === 'accepted' && (
                <>
                  <span className="self-center text-xs text-muted">
                    Tiến độ: {open.tasks.filter((t) => t.status === 'completed').length}/{open.tasks.length} việc hoàn thành ·{' '}
                    <Link href="/tasks" className="underline">
                      Trang Giao việc
                    </Link>
                  </span>
                  {open.tasks.every((t) => FINISHED.includes(t.status)) && open.reportStatus !== 'running' && (
                    <button disabled={busy} onClick={() => act(open, 'report', 'Đã gửi yêu cầu, báo cáo hiện bên dưới khi xong.')} className={btnCls}>
                      {open.report ? 'Viết lại báo cáo' : 'Tổng hợp báo cáo'}
                    </button>
                  )}
                </>
              )}
            </div>
            {open.reportStatus === 'running' && <p className="mt-3 text-sm text-muted">MARIS đang tổng hợp báo cáo…</p>}
            {open.report && (
              <div className="mt-4 rounded-md border border-accent p-3">
                <div className="mb-2 text-xs font-semibold text-accent">Báo cáo của MARIS</div>
                <div className="text-sm">
                  <Markdown text={open.report} />
                </div>
              </div>
            )}
          </Panel>
        </div>
      )}

      <Panel title="Giao mục tiêu mới">
        <form onSubmit={create} className="grid max-w-2xl gap-3" autoComplete="off">
          <label className="text-sm">
            Mục tiêu kinh doanh
            <textarea
              name="goal"
              required
              maxLength={4000}
              rows={3}
              placeholder="Ví dụ: Tăng doanh số cần câu trên Shopee 30% trong tháng 12 với ngân sách quảng cáo 10 triệu"
              className={`${inputCls} mt-1`}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Ngân sách AI cho cả kế hoạch (USD)
              <input name="budgetUsd" type="number" required min={0.01} max={1000} step={0.01} defaultValue={1} className={`${inputCls} mt-1`} />
            </label>
            <label className="text-sm">
              Dự án (MARIS dùng bộ nhớ của dự án)
              <select name="projectId" defaultValue="" className={`${inputCls} mt-1`}>
                <option value="">Không gắn dự án</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted">
            MARIS giao việc cho {activeAgents} Agent đang bật.{' '}
            {activeAgents === 0 && (
              <>
                Chưa có Agent nào, MARIS sẽ tự làm mọi bước.{' '}
                <Link href="/agents" className="underline">
                  Thêm Agent
                </Link>
              </>
            )}
          </p>
          <button disabled={busy} className={`${btnCls} justify-self-start`}>
            Lập kế hoạch
          </button>
        </form>
      </Panel>

      <Panel title={`Các kế hoạch (${plans.length})`}>
        {plans.length === 0 ? (
          <p className="text-sm text-muted">Chưa có kế hoạch nào.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {plans.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2">
                <button onClick={() => loadOpen(p.id, true)} className="min-w-0 flex-1 truncate text-left hover:underline">
                  {p.goal}
                </button>
                <span className={`text-xs ${STATUS_COLOR[p.status] ?? ''}`}>{PLAN_STATUS_LABEL[p.status]}</span>
                <span className="text-xs text-muted">{new Date(p.createdAt).toLocaleString('vi-VN')}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Shell>
  );
}
