'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import type { MemoryResponse, ProjectResponse } from '@maris/contracts';
import { Shell } from '@/components/Shell';
import { btnCls, btnGhostCls, inputCls, Notice, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

export default function MemoryPage() {
  const me = useMe();
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryResponse[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadProjects = useCallback(() => {
    api<ProjectResponse[]>('/ai/projects')
      .then((list) => {
        setProjects(list);
        setCurrent((c) => (c && list.some((p) => p.id === c) ? c : (list[0]?.id ?? null)));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (me) loadProjects();
  }, [me, loadProjects]);
  useEffect(() => {
    if (!current) return setMemories([]);
    api<MemoryResponse[]>(`/ai/projects/${current}/memories`).then(setMemories).catch((e: Error) => setError(e.message));
  }, [current]);

  const reloadMemories = async () => {
    if (current) setMemories(await api<MemoryResponse[]>(`/ai/projects/${current}/memories`));
    loadProjects();
  };

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

  async function addProject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await run(async () => {
      const p = await api<ProjectResponse>('/ai/projects', {
        method: 'POST',
        body: JSON.stringify({ name: String(f.get('name')).trim(), description: String(f.get('description') ?? '').trim() || null }),
      });
      form.reset();
      setCurrent(p.id);
      setOk(`Đã tạo dự án “${p.name}”.`);
      loadProjects();
    });
  }

  const removeProject = (p: ProjectResponse) => {
    if (!confirm(`Xóa dự án “${p.name}” và toàn bộ ${p.memoryCount} mục bộ nhớ của nó?`)) return;
    void run(async () => {
      await api(`/ai/projects/${p.id}`, { method: 'DELETE' });
      setOk(`Đã xóa dự án “${p.name}”.`);
      setCurrent(null);
      loadProjects();
    });
  };

  async function addMemory(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await run(async () => {
      await api(`/ai/projects/${current}/memories`, {
        method: 'POST',
        body: JSON.stringify({ title: String(f.get('title')).trim(), content: String(f.get('content')).trim(), pinned: f.get('pinned') === 'on' }),
      });
      form.reset();
      setOk('Đã lưu vào bộ nhớ.');
      await reloadMemories();
    });
  }

  async function saveMemory(m: MemoryResponse, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      await api(`/ai/memories/${m.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: String(f.get('title')).trim(), content: String(f.get('content')).trim() }),
      });
      setEditing(null);
      setOk('Đã lưu thay đổi.');
      await reloadMemories();
    });
  }

  const pin = (m: MemoryResponse) =>
    run(async () => {
      await api(`/ai/memories/${m.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !m.pinned }) });
      await reloadMemories();
    });

  const removeMemory = (m: MemoryResponse) => {
    if (!confirm(`Xóa mục “${m.title}”?`)) return;
    void run(async () => {
      await api(`/ai/memories/${m.id}`, { method: 'DELETE' });
      setOk(`Đã xóa “${m.title}”.`);
      await reloadMemories();
    });
  };

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  const project = projects.find((p) => p.id === current);

  return (
    <Shell me={me}>
      <h1 className="mb-1 text-xl font-semibold">Bộ nhớ và kiến thức</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted">
        Lưu những điều AI cần nhớ về từng dự án: khách hàng, sản phẩm, giọng thương hiệu, quyết định đã chốt. Khi bạn chọn dự án trong{' '}
        <Link href="/chat" className="underline">Chat AI</Link>, mọi AI đều đọc bộ nhớ này, dù bạn đổi AI Provider. Mục được ghim luôn được đọc trước.
        Không lưu mật khẩu hay API key ở đây.
      </p>
      <div className="sticky top-0 z-10 bg-bg">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
      </div>

      <div className="flex gap-4 max-md:flex-col">
        <aside className="w-64 shrink-0 max-md:w-full">
          <Panel title="Dự án">
            <ul className="mb-3 text-sm">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => setCurrent(p.id)}
                    className={`w-full truncate rounded px-2 py-1.5 text-left ${current === p.id ? 'bg-bg text-accent' : 'hover:bg-bg'}`}
                  >
                    {p.name} <span className="text-xs text-muted">({p.memoryCount})</span>
                  </button>
                </li>
              ))}
              {projects.length === 0 && <li className="text-xs text-muted">Chưa có dự án nào.</li>}
            </ul>
            <form onSubmit={addProject} className="grid gap-2" autoComplete="off">
              <input name="name" required maxLength={120} placeholder="Tên dự án mới" className={inputCls} />
              <input name="description" maxLength={2000} placeholder="Mô tả ngắn (không bắt buộc)" className={inputCls} />
              <button disabled={busy} className={btnCls}>
                + Tạo dự án
              </button>
            </form>
          </Panel>
        </aside>

        <section className="min-w-0 flex-1">
          {project ? (
            <>
              <Panel title={`Bộ nhớ của “${project.name}”`}>
                {project.description && <p className="mb-3 text-sm text-muted">{project.description}</p>}
                <ul className="divide-y divide-line text-sm">
                  {memories.map((m) => (
                    <li key={m.id} className="py-2">
                      {editing === m.id ? (
                        <form onSubmit={(e) => saveMemory(m, e)} className="grid gap-2" autoComplete="off">
                          <input name="title" required maxLength={200} defaultValue={m.title} className={inputCls} />
                          <textarea name="content" required maxLength={4000} rows={4} defaultValue={m.content} className={inputCls} />
                          <div className="flex gap-2">
                            <button disabled={busy} className={btnCls}>
                              Lưu
                            </button>
                            <button type="button" onClick={() => setEditing(null)} className={btnGhostCls}>
                              Hủy
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div className="flex flex-wrap items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="font-medium">
                              {m.pinned && <span className="mr-1" title="Đã ghim">📌</span>}
                              {m.title}
                            </div>
                            <div className="whitespace-pre-wrap text-xs text-muted">{m.content}</div>
                          </div>
                          <div className="flex gap-1">
                            <button disabled={busy} onClick={() => pin(m)} className={btnGhostCls}>
                              {m.pinned ? 'Bỏ ghim' : 'Ghim'}
                            </button>
                            <button disabled={busy} onClick={() => setEditing(m.id)} className={btnGhostCls}>
                              Sửa
                            </button>
                            <button disabled={busy} onClick={() => removeMemory(m)} className={`${btnGhostCls} border-danger text-danger`}>
                              Xóa
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                  {memories.length === 0 && <li className="py-2 text-muted">Chưa có mục nào. Thêm ở khung bên dưới.</li>}
                </ul>
              </Panel>
              <Panel title="Thêm vào bộ nhớ">
                <form onSubmit={addMemory} className="grid max-w-2xl gap-3" autoComplete="off">
                  <input name="title" required maxLength={200} placeholder="Tiêu đề, ví dụ: Khách hàng mục tiêu" className={inputCls} />
                  <textarea name="content" required maxLength={4000} rows={4} placeholder="Nội dung AI cần nhớ" className={inputCls} />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="pinned" /> Ghim (luôn đọc trước)
                  </label>
                  <div className="flex gap-2">
                    <button disabled={busy} className={btnCls}>
                      Lưu vào bộ nhớ
                    </button>
                    <button type="button" disabled={busy} onClick={() => removeProject(project)} className={`${btnGhostCls} border-danger text-danger`}>
                      Xóa dự án
                    </button>
                  </div>
                </form>
              </Panel>
            </>
          ) : (
            <p className="text-sm text-muted">Tạo một dự án ở bên trái để bắt đầu lưu bộ nhớ.</p>
          )}
        </section>
      </div>
    </Shell>
  );
}
