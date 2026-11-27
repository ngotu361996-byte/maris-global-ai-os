'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { AgentResponse, AgentVersionResponse, AiProviderResponse } from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

const KEY_LIKE = /^(sk-|sk_|rk-|AIza|xai-|gsk_)/;

export default function AgentsPage() {
  const me = useMe();
  const [agents, setAgents] = useState<AgentResponse[]>([]);
  const [providers, setProviders] = useState<AiProviderResponse[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [versions, setVersions] = useState<{ id: string; list: AgentVersionResponse[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const load = useCallback(() => {
    api<AgentResponse[]>('/ai/agents').then(setAgents).catch((e: Error) => setError(e.message));
    api<AiProviderResponse[]>('/ai/providers').then(setProviders).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (me) load();
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

  const installAll = () =>
    run(async () => {
      const created = await api<AgentResponse[]>('/ai/agents/templates', { method: 'POST', body: JSON.stringify({}) });
      setOk(created.length ? `Đã thêm ${created.length} Agent mẫu.` : 'Các Agent mẫu đã có đủ.');
      load();
    });

  function formBody(f: FormData) {
    const text = (k: string) => String(f.get(k) ?? '').trim();
    const model = text('model');
    if (KEY_LIKE.test(model) || model.length >= 120) throw new Error('Ô Model đang chứa một API key. Key chỉ dán vào Secret Vault.');
    return {
      name: text('name'),
      role: text('role'),
      systemPrompt: text('systemPrompt'),
      evalCriteria: text('evalCriteria') || null,
      providerId: text('providerId') || null,
      model: model || null,
    };
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await run(async () => {
      const a = await api<AgentResponse>('/ai/agents', { method: 'POST', body: JSON.stringify({ key: String(f.get('key')).trim(), ...formBody(f) }) });
      form.reset();
      setOk(`Đã tạo “${a.name}”.`);
      load();
    });
  }

  async function save(a: AgentResponse, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      const u = await api<AgentResponse>(`/ai/agents/${a.id}`, { method: 'PATCH', body: JSON.stringify(formBody(f)) });
      setEditing(null);
      setOk(`Đã lưu “${u.name}” (phiên bản ${u.version}).`);
      load();
    });
  }

  const toggle = (a: AgentResponse) =>
    run(async () => {
      await api(`/ai/agents/${a.id}`, { method: 'PATCH', body: JSON.stringify({ status: a.status === 'active' ? 'paused' : 'active' }) });
      setOk(a.status === 'active' ? `Đã tạm dừng ${a.name}.` : `Đã bật ${a.name}.`);
      load();
    });

  const remove = (a: AgentResponse) => {
    if (!confirm(`Xóa “${a.name}”? Lịch sử chat vẫn giữ nguyên.`)) return;
    void run(async () => {
      await api(`/ai/agents/${a.id}`, { method: 'DELETE' });
      setOk(`Đã xóa “${a.name}”.`);
      load();
    });
  };

  const showVersions = (a: AgentResponse) =>
    run(async () => {
      if (versions?.id === a.id) return setVersions(null);
      setVersions({ id: a.id, list: await api<AgentVersionResponse[]>(`/ai/agents/${a.id}/versions`) });
    });

  const providerName = (id: string | null) => (id ? (providers.find((p) => p.id === id)?.name ?? 'AI đã xóa') : 'Theo thứ tự AI Provider');

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const shown = agents.filter((a) => !filter || `${a.name} ${a.role}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">AI Agent</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Mỗi Agent là một chuyên gia AI có vai trò và cách làm việc riêng. Chọn Agent trong <Link href="/chat" className="underline">Chat AI</Link> để
        trò chuyện với Agent đó. Mỗi lần sửa, MARIS lưu lại một phiên bản. Agent chỉ trò chuyện và đề xuất, chưa tự thực hiện hành động bên ngoài.
      </p>
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      <Panel title={`Danh sách Agent (${agents.length})`}>
        <div className="mb-3 flex flex-wrap gap-2">
          <button onClick={installAll} disabled={busy} className={btnCls}>
            Thêm các Agent mẫu theo đặc tả
          </button>
          {agents.length > 0 && (
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Tìm Agent…" className={`${inputCls} max-w-xs`} />
          )}
        </div>
        {agents.length === 0 ? (
          <p className="text-sm text-muted">Chưa có Agent nào. Bấm nút trên để thêm 34 Agent mẫu, hoặc tạo Agent riêng ở khung bên dưới.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {shown.map((a) => (
              <li key={a.id} className="py-2">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {a.name}
                      {a.status === 'paused' && <span className="ml-2 text-xs text-muted">(tạm dừng)</span>}
                      <span className="ml-2 text-[11px] text-muted">v{a.version}</span>
                    </div>
                    <div className="text-xs text-muted">{a.role}</div>
                    <div className="text-[11px] text-muted">
                      {providerName(a.providerId)}
                      {a.model ? ` · ${a.model}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button disabled={busy} onClick={() => setEditing(editing === a.id ? null : a.id)} className={btnGhostCls}>
                      {editing === a.id ? 'Đóng' : 'Sửa'}
                    </button>
                    <button disabled={busy} onClick={() => showVersions(a)} className={btnGhostCls}>
                      Phiên bản
                    </button>
                    <button disabled={busy} onClick={() => toggle(a)} className={btnGhostCls}>
                      {a.status === 'active' ? 'Tạm dừng' : 'Bật'}
                    </button>
                    <button disabled={busy} onClick={() => remove(a)} className={`${btnGhostCls} border-danger text-danger`}>
                      Xóa
                    </button>
                  </div>
                </div>
                {editing === a.id && (
                  <form onSubmit={(e) => save(a, e)} className="mt-3 grid max-w-2xl gap-3" autoComplete="off">
                    <AgentFields agent={a} providers={providers} />
                    <button disabled={busy} className={`${btnCls} justify-self-start`}>
                      Lưu phiên bản mới
                    </button>
                  </form>
                )}
                {versions?.id === a.id && (
                  <ul className="mt-2 space-y-1 text-xs text-muted">
                    {versions.list.map((v) => (
                      <li key={v.version}>
                        v{v.version} · {new Date(v.createdAt).toLocaleString('vi-VN')} · {v.config.status === 'paused' ? 'tạm dừng' : 'đang bật'} ·{' '}
                        {providerName((v.config.providerId as string | null) ?? null)}
                        {v.config.model ? ` · ${String(v.config.model)}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Tạo Agent mới">
        <form onSubmit={create} className="grid max-w-2xl gap-3" autoComplete="off">
          <label className="text-sm">
            Mã Agent (chữ thường không dấu, ví dụ <span className="font-mono">ban-hang-vip</span>)
            <input name="key" required pattern="[a-z0-9][a-z0-9_\-]{0,63}" className={`${inputCls} mt-1`} />
          </label>
          <AgentFields providers={providers} />
          <button disabled={busy} className={`${btnCls} justify-self-start`}>
            Tạo Agent
          </button>
        </form>
      </Panel>
    </Shell>
  );
}

function AgentFields({ agent, providers }: { agent?: AgentResponse; providers: AiProviderResponse[] }) {
  return (
    <>
      <label className="text-sm">
        Tên hiển thị
        <input name="name" required maxLength={80} defaultValue={agent?.name} className={`${inputCls} mt-1`} />
      </label>
      <label className="text-sm">
        Vai trò (một câu)
        <input name="role" required maxLength={300} defaultValue={agent?.role} className={`${inputCls} mt-1`} />
      </label>
      <label className="text-sm">
        Hướng dẫn cho Agent (prompt)
        <textarea name="systemPrompt" required maxLength={8000} rows={4} defaultValue={agent?.systemPrompt} className={`${inputCls} mt-1`} />
      </label>
      <label className="text-sm">
        Tiêu chí đánh giá câu trả lời (không bắt buộc)
        <input name="evalCriteria" maxLength={2000} defaultValue={agent?.evalCriteria ?? ''} className={`${inputCls} mt-1`} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          AI Provider
          <select name="providerId" defaultValue={agent?.providerId ?? ''} className={`${inputCls} mt-1`}>
            <option value="">Theo thứ tự AI Provider</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Model (để trống = model mặc định)
          <input name="model" maxLength={200} defaultValue={agent?.model ?? ''} className={`${inputCls} mt-1`} />
        </label>
      </div>
    </>
  );
}
