'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  TASK_STATUS_LABEL,
  type AgentResponse,
  type ProjectResponse,
  type TaskResponse,
  type TaskStatus,
} from '@maris/contracts';
import { TASK_DRAFT_KEY } from '@/components/ChatPanel';
import { Markdown } from '@/components/Markdown';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

interface Draft {
  scope?: string;
  agentId?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
}

const FILTERS: { label: string; statuses: TaskStatus[] | null }[] = [
  { label: 'Đang mở', statuses: ['pending', 'queued', 'running', 'paused'] },
  { label: 'Chờ duyệt', statuses: ['pending'] },
  { label: 'Đã xong', statuses: ['completed'] },
  { label: 'Tất cả', statuses: null },
];

const STATUS_COLOR: Partial<Record<TaskStatus, string>> = {
  pending: 'text-accent',
  running: 'text-green-500',
  completed: 'text-green-500',
  failed: 'text-danger',
  rejected: 'text-muted',
  cancelled: 'text-muted',
};

export default function TasksPage() {
  const me = useMe();
  const [tasks, setTasks] = useState<TaskResponse[]>([]);
  const [agents, setAgents] = useState<AgentResponse[]>([]);
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [filter, setFilter] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<TaskResponse[]>('/ai/tasks').then(setTasks).catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!me) return;
    load();
    api<AgentResponse[]>('/ai/agents').then(setAgents).catch(() => undefined);
    api<ProjectResponse[]>('/ai/projects').then(setProjects).catch(() => undefined);
    try {
      const raw = sessionStorage.getItem(TASK_DRAFT_KEY);
      if (raw) {
        setDraft(JSON.parse(raw) as Draft);
        sessionStorage.removeItem(TASK_DRAFT_KEY);
      }
    } catch {
      // A broken draft is simply ignored.
    }
    // Live progress while something is queued or running.
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [me, load]);

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

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    await run(async () => {
      const t = await api<TaskResponse>('/ai/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: text('title'),
          goal: text('goal'),
          scope: text('scope'),
          successCriteria: text('successCriteria'),
          budgetUsd: Number(f.get('budgetUsd')),
          agentId: text('agentId') || null,
          projectId: text('projectId') || null,
          conversationId: draft?.conversationId ?? null,
        }),
      });
      form.reset();
      setDraft(null);
      setOk(`Đã tạo “${t.title}”. Công việc chờ người có quyền phê duyệt.`);
      setFilter(0);
      load();
    });
  }

  const act = (t: TaskResponse, action: 'approve' | 'reject' | 'pause' | 'resume' | 'cancel', message: string) =>
    run(async () => {
      let note: string | undefined;
      if (action === 'reject') {
        const n = prompt('Lý do từ chối (không bắt buộc):');
        if (n === null) return;
        note = n.trim() || undefined;
      }
      if (action === 'cancel' && !confirm(`Hủy “${t.title}”?`)) return;
      await api(`/ai/tasks/${t.id}/${action}`, { method: 'POST', body: JSON.stringify(note ? { note } : {}) });
      setOk(message);
      load();
    });

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const statuses = FILTERS[filter]!.statuses;
  const shown = tasks.filter((t) => !statuses || statuses.includes(t.status));
  const agentName = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? 'Agent đã xóa') : 'MARIS');
  const activeAgents = agents.filter((a) => a.status === 'active');

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Giao việc</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Mỗi việc giao cho AI phải có mục tiêu, phạm vi, ngân sách và tiêu chí hoàn thành, và chỉ chạy sau khi người có quyền phê duyệt bấm
        “Duyệt”. Ở giai đoạn này AI chỉ soạn nội dung (kế hoạch, bài viết, phân tích); việc đăng bài, gửi tin hay chi tiền sẽ có khi kết nối
        các kênh ở giai đoạn sau.
      </p>
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      <Panel title="Công việc">
        <div className="mb-3 flex flex-wrap gap-1">
          {FILTERS.map((f, i) => (
            <button key={f.label} onClick={() => setFilter(i)} className={`${btnGhostCls} ${filter === i ? 'border-accent text-accent' : ''}`}>
              {f.label} ({tasks.filter((t) => !f.statuses || f.statuses.includes(t.status)).length})
            </button>
          ))}
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-muted">Không có công việc nào ở mục này.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {shown.map((t) => (
              <li key={t.id} className="py-2">
                <div className="flex flex-wrap items-start gap-2">
                  <button onClick={() => setOpen(open === t.id ? null : t.id)} className="min-w-0 flex-1 text-left">
                    <div className="font-medium">{t.title}</div>
                    <div className="text-xs text-muted">
                      <span className={STATUS_COLOR[t.status] ?? ''}>{TASK_STATUS_LABEL[t.status]}</span>
                      {t.progress && t.status !== 'completed' ? ` · ${t.progress}` : ''} · {agentName(t.agentId)} · ngân sách ${t.budgetUsd} · đã
                      dùng ${t.costUsd.toFixed(4)} · {new Date(t.updatedAt).toLocaleString('vi-VN')}
                      {t.skillVersion ? ` · từ Skill v${t.skillVersion}` : ''}
                      {t.workflowRunId ? ' · từ Workflow' : ''}
                    </div>
                  </button>
                  <div className="flex flex-wrap gap-1">
                    {t.status === 'pending' && (
                      <>
                        <button disabled={busy} onClick={() => act(t, 'approve', `Đã duyệt “${t.title}”. AI bắt đầu làm.`)} className={btnCls}>
                          Duyệt
                        </button>
                        <button disabled={busy} onClick={() => act(t, 'reject', `Đã từ chối “${t.title}”.`)} className={btnGhostCls}>
                          Từ chối
                        </button>
                      </>
                    )}
                    {(t.status === 'queued' || t.status === 'running') && (
                      <button disabled={busy} onClick={() => act(t, 'pause', `Đã tạm dừng “${t.title}”.`)} className={btnGhostCls}>
                        Tạm dừng
                      </button>
                    )}
                    {(t.status === 'paused' || t.status === 'failed') && (
                      <button disabled={busy} onClick={() => act(t, 'resume', `“${t.title}” chạy lại.`)} className={btnGhostCls}>
                        Chạy tiếp
                      </button>
                    )}
                    {['pending', 'queued', 'running', 'paused'].includes(t.status) && (
                      <button disabled={busy} onClick={() => act(t, 'cancel', `Đã hủy “${t.title}”.`)} className={`${btnGhostCls} border-danger text-danger`}>
                        Hủy
                      </button>
                    )}
                  </div>
                </div>
                {open === t.id && (
                  <div className="mt-2 grid gap-2 rounded-md border border-line bg-bg p-3 text-xs">
                    <Field label="Mục tiêu" value={t.goal} />
                    <div>
                      <span className="font-medium text-ink">Phạm vi:</span>
                      <div className="text-muted">
                        <Markdown text={t.scope} />
                      </div>
                    </div>
                    <Field label="Tiêu chí hoàn thành" value={t.successCriteria} />
                    <Field label="Quyền hạn" value="Chỉ soạn nội dung văn bản bằng AI" />
                    {t.decisionNote && <Field label="Ghi chú khi duyệt" value={t.decisionNote} />}
                    {t.errorCode && <Field label="Lỗi" value={`${t.errorCode}${t.progress ? `: ${t.progress}` : ''}`} />}
                    {t.result && (
                      <div>
                        <div className="mb-1 font-medium text-ink">Kết quả</div>
                        <div className="text-sm text-ink">
                          <Markdown text={t.result} />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={draft ? 'Giao việc từ câu trả lời trong chat' : 'Giao việc mới'}>
        <form key={draft ? 'draft' : 'blank'} onSubmit={create} className="grid max-w-2xl gap-3" autoComplete="off">
          <label className="text-sm">
            Tên công việc
            <input name="title" required maxLength={200} className={`${inputCls} mt-1`} placeholder="Ví dụ: Kế hoạch nội dung tuần 49" />
          </label>
          <label className="text-sm">
            Mục tiêu
            <textarea name="goal" required maxLength={4000} rows={2} className={`${inputCls} mt-1`} placeholder="Cần đạt được gì?" />
          </label>
          <label className="text-sm">
            Phạm vi (AI được và không được làm gì)
            <textarea name="scope" required maxLength={4000} rows={draft?.scope ? 8 : 3} defaultValue={draft?.scope ?? ''} className={`${inputCls} mt-1`} />
          </label>
          <label className="text-sm">
            Tiêu chí hoàn thành
            <textarea name="successCriteria" required maxLength={2000} rows={2} className={`${inputCls} mt-1`} placeholder="Thế nào là xong và đạt?" />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              Ngân sách (USD)
              <input name="budgetUsd" type="number" min="0.01" max="1000" step="0.01" defaultValue="0.5" required className={`${inputCls} mt-1`} />
            </label>
            <label className="text-sm">
              Giao cho
              <select name="agentId" defaultValue={draft?.agentId ?? ''} className={`${inputCls} mt-1`}>
                <option value="">MARIS (AI tổng điều hành)</option>
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Dự án
              <select name="projectId" defaultValue={draft?.projectId ?? ''} className={`${inputCls} mt-1`}>
                <option value="">Không gắn dự án</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button disabled={busy} className={`${btnCls} justify-self-start`}>
            Gửi để phê duyệt
          </button>
        </form>
      </Panel>
    </Shell>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="font-medium text-ink">{label}: </span>
      <span className="whitespace-pre-wrap text-muted">{value}</span>
    </div>
  );
}
