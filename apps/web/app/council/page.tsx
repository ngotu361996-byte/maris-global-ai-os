'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  COUNCIL_MAX_MEMBERS,
  COUNCIL_STAGE_LABEL,
  COUNCIL_STATUS_LABEL,
  type AiProviderResponse,
  type CouncilDetailResponse,
  type CouncilResponse,
  type CouncilStatus,
  type ProjectResponse,
} from '@maris/contracts';
import { Markdown } from '@/components/Markdown';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const STATUS_COLOR: Partial<Record<CouncilStatus, string>> = {
  running: 'text-accent',
  completed: 'text-green-500',
  failed: 'text-danger',
  cancelled: 'text-muted',
};

interface Member {
  providerId: string;
  model: string;
}

export default function CouncilPage() {
  const me = useMe();
  const [councils, setCouncils] = useState<CouncilResponse[]>([]);
  const [providers, setProviders] = useState<AiProviderResponse[]>([]);
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [open, setOpen] = useState<CouncilDetailResponse | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<CouncilResponse[]>('/ai/councils')
      .then(setCouncils)
      .catch((e: Error) => setError(e.message));
  }, []);

  const loadOpen = useCallback((id: string, reveal = false) => {
    api<CouncilDetailResponse>(`/ai/councils/${id}`)
      .then((c) => {
        setOpen(c);
        if (reveal)
          requestAnimationFrame(() =>
            document
              .getElementById('council-result')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          );
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!me) return;
    load();
    api<AiProviderResponse[]>('/ai/providers')
      .then((ps) => {
        setProviders(ps);
        // Start with the first two enabled AIs, or the same AI twice when there is only one.
        const on = ps.filter((p) => p.enabled);
        if (on.length)
          setMembers(
            [0, 1].map((i) => ({ providerId: on[Math.min(i, on.length - 1)]!.id, model: '' })),
          );
      })
      .catch(() => undefined);
    api<ProjectResponse[]>('/ai/projects')
      .then(setProjects)
      .catch(() => undefined);
  }, [me, load]);

  // Live progress while a session is running.
  const openId = open?.id;
  const openLive = open && (open.status === 'queued' || open.status === 'running');
  const anyLive = councils.some((c) => c.status === 'queued' || c.status === 'running');
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
      const c = await api<CouncilResponse>('/ai/councils', {
        method: 'POST',
        body: JSON.stringify({
          question: String(f.get('question') ?? '').trim(),
          members: members.map((m) => ({
            providerId: m.providerId,
            ...(m.model.trim() ? { model: m.model.trim() } : {}),
          })),
          critique: f.get('critique') === 'on',
          maxCostUsd: Number(f.get('maxCostUsd')),
          projectId: String(f.get('projectId') ?? '') || null,
        }),
      });
      form.reset();
      setOk('Hội đồng đã bắt đầu họp. Kết quả hiện bên dưới khi xong.');
      load();
      loadOpen(c.id, true);
    });
  }

  const cancel = (c: CouncilResponse) =>
    run(async () => {
      if (!confirm('Dừng phiên họp này?')) return;
      await api(`/ai/councils/${c.id}/cancel`, { method: 'POST', body: '{}' });
      setOk('Đã dừng phiên họp.');
      load();
      if (open?.id === c.id) loadOpen(c.id);
    });

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const enabled = providers.filter((p) => p.enabled);
  const providerName = (id: string | null) =>
    id ? (providers.find((p) => p.id === id)?.name ?? 'AI đã xóa') : '—';
  const setMember = (i: number, patch: Partial<Member>) =>
    setMembers((ms) => ms.map((m, k) => (k === i ? { ...m, ...patch } : m)));

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Hội đồng AI</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Nhiều AI cùng trả lời một câu hỏi một cách độc lập, sau đó phản biện lẫn nhau, rồi một AI
        viết bản tổng hợp gồm phương án khuyến nghị, điểm đồng thuận, điểm bất đồng và điều cần kiểm
        chứng. Mỗi phiên có giới hạn 2 đến 4 AI và giới hạn chi phí. Hội đồng chỉ viết nội dung,
        không tự làm gì. Các AI đồng ý với nhau không có nghĩa là đúng; bạn vẫn cần kiểm chứng các
        dữ kiện quan trọng.
      </p>
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      {open && (
        <div id="council-result" className="scroll-mt-4">
          <Panel title="Kết quả phiên họp">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="whitespace-pre-wrap text-sm font-medium">{open.question}</div>
                <div className="mt-1 text-xs text-muted">
                  <span className={STATUS_COLOR[open.status] ?? ''}>
                    {COUNCIL_STATUS_LABEL[open.status]}
                  </span>
                  {open.stage && open.status !== 'completed' ? ` · ${open.stage}` : ''} · đã dùng $
                  {open.costUsd.toFixed(4)} / giới hạn ${open.maxCostUsd}
                </div>
              </div>
              <button onClick={() => setOpen(null)} className={btnGhostCls}>
                Đóng
              </button>
            </div>
            {open.synthesis && (
              <div className="mb-4 rounded-md border border-accent p-3">
                <div className="mb-2 text-xs font-semibold text-accent">Bản tổng hợp</div>
                <div className="text-sm">
                  <Markdown text={open.synthesis} />
                </div>
              </div>
            )}
            {(['answer', 'critique'] as const).map((stage) => {
              const turns = open.turns.filter((t) => t.stage === stage);
              if (!turns.length) return null;
              return (
                <div key={stage} className="mb-4">
                  <div className="mb-2 text-xs font-semibold text-muted">
                    {COUNCIL_STAGE_LABEL[stage]}
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {turns.map((t) => (
                      <details
                        key={t.id}
                        className="rounded-md border border-line bg-bg p-3 text-sm"
                        open={stage === 'answer' && !open.synthesis}
                      >
                        <summary className="cursor-pointer text-xs">
                          <span className="font-medium">AI số {t.memberIndex + 1}</span> ·{' '}
                          {providerName(t.providerId)} <span className="font-mono">{t.model}</span>
                          {t.status !== 'complete' && (
                            <span className="ml-2 text-danger">Lỗi {t.errorCode}</span>
                          )}
                        </summary>
                        {t.content && (
                          <div className="mt-2">
                            <Markdown text={t.content} />
                          </div>
                        )}
                      </details>
                    ))}
                  </div>
                </div>
              );
            })}
          </Panel>
        </div>
      )}

      <Panel title="Họp hội đồng mới">
        {enabled.length === 0 ? (
          <p className="text-sm text-muted">
            Cần bật ít nhất một AI ở trang{' '}
            <a href="/ai" className="underline">
              AI Provider
            </a>
            .
          </p>
        ) : (
          <form onSubmit={create} className="grid max-w-3xl gap-3" autoComplete="off">
            <label className="text-sm">
              Câu hỏi hoặc vấn đề cần hội đồng bàn
              <textarea
                name="question"
                required
                maxLength={8000}
                rows={4}
                className={`${inputCls} mt-1`}
                placeholder="Ví dụ: Nên bán cần câu qua TikTok Shop hay Shopee trước, với ngân sách quảng cáo 10 triệu một tháng?"
              />
            </label>
            <div className="text-sm">
              Thành viên hội đồng ({members.length}/{COUNCIL_MAX_MEMBERS})
              <div className="mt-1 grid gap-2">
                {members.map((m, i) => (
                  <div
                    key={i}
                    className="grid items-center gap-2 sm:grid-cols-[4rem_12rem_1fr_auto]"
                  >
                    <span className="text-xs text-muted">AI số {i + 1}</span>
                    <select
                      value={m.providerId}
                      onChange={(e) => setMember(i, { providerId: e.target.value })}
                      className={inputCls}
                    >
                      {enabled.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <input
                      value={m.model}
                      onChange={(e) => setMember(i, { model: e.target.value })}
                      maxLength={200}
                      placeholder={`Model (để trống: ${enabled.find((p) => p.id === m.providerId)?.defaultModel ?? 'mặc định'})`}
                      className={`${inputCls} min-w-0`}
                    />
                    {members.length > 2 && (
                      <button
                        type="button"
                        onClick={() => setMembers((ms) => ms.filter((_, k) => k !== i))}
                        className={btnGhostCls}
                      >
                        Bỏ
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {members.length < COUNCIL_MAX_MEMBERS && (
                <button
                  type="button"
                  onClick={() =>
                    setMembers((ms) => [
                      ...ms,
                      { providerId: enabled[ms.length % enabled.length]!.id, model: '' },
                    ])
                  }
                  className={`${btnGhostCls} mt-2`}
                >
                  Thêm thành viên
                </button>
              )}
              {enabled.length === 1 && (
                <p className="mt-2 text-xs text-muted">
                  Bạn mới có một AI. Có thể dùng cùng AI với các model khác nhau, nhưng ý kiến sẽ đa
                  dạng hơn khi có thêm AI khác (Claude, Gemini…).
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm">
                Giới hạn chi phí (USD)
                <input
                  name="maxCostUsd"
                  type="number"
                  min="0.01"
                  max="50"
                  step="0.01"
                  defaultValue="0.5"
                  required
                  className={`${inputCls} mt-1`}
                />
              </label>
              <label className="text-sm">
                Dự án
                <select name="projectId" defaultValue="" className={`${inputCls} mt-1`}>
                  <option value="">Không gắn dự án</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" name="critique" defaultChecked />
                Cho các AI phản biện nhau
              </label>
            </div>
            <button disabled={busy} className={`${btnCls} justify-self-start`}>
              Bắt đầu họp
            </button>
          </form>
        )}
      </Panel>

      <Panel title="Các phiên họp">
        {councils.length === 0 ? (
          <p className="text-sm text-muted">Chưa có phiên họp nào.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {councils.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-2 py-2">
                <button onClick={() => loadOpen(c.id, true)} className="min-w-0 flex-1 text-left">
                  <div className="truncate font-medium">{c.question}</div>
                  <div className="text-xs text-muted">
                    <span className={STATUS_COLOR[c.status] ?? ''}>
                      {COUNCIL_STATUS_LABEL[c.status]}
                    </span>
                    {c.stage && (c.status === 'running' || c.status === 'failed')
                      ? ` · ${c.stage}`
                      : ''}{' '}
                    · {c.members.length} AI · đã dùng ${c.costUsd.toFixed(4)} ·{' '}
                    {new Date(c.createdAt).toLocaleString('vi-VN')}
                  </div>
                </button>
                {(c.status === 'queued' || c.status === 'running') && (
                  <button
                    disabled={busy}
                    onClick={() => cancel(c)}
                    className={`${btnGhostCls} border-danger text-danger`}
                  >
                    Dừng
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Shell>
  );
}
