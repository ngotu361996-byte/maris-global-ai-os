'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ConversationResponse } from '@maris/contracts';
import { ChatPanel } from '@/components/ChatPanel';
import { Shell } from '@/components/Shell';
import { btnCls } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

export default function ChatPage() {
  const me = useMe();
  const [items, setItems] = useState<ConversationResponse[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  // Remounts the panel only when the user picks a conversation, not when the panel creates one mid-reply.
  const [panelKey, setPanelKey] = useState(0);
  const open = (id: string | null) => {
    setCurrent(id);
    setPanelKey((k) => k + 1);
  };
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ConversationResponse[]>('/ai/conversations').then(setItems).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  async function remove(c: ConversationResponse) {
    if (!confirm(`Xóa cuộc trò chuyện “${c.title}”?`)) return;
    try {
      await api(`/ai/conversations/${c.id}`, { method: 'DELETE' });
      if (current === c.id) open(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lỗi không xác định');
    }
  }

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  return (
    <Shell me={me} hideChat>
      <div className="flex h-full min-h-0 gap-4 max-md:flex-col">
        <aside className="flex w-64 shrink-0 flex-col max-md:w-full max-md:max-h-48">
          <button onClick={() => open(null)} className={`${btnCls} mb-3`}>
            + Cuộc trò chuyện mới
          </button>
          {error && <p className="mb-2 text-xs text-danger">{error}</p>}
          <ul className="min-h-0 flex-1 overflow-y-auto text-sm">
            {items.map((c) => (
              <li key={c.id} className="group flex items-center">
                <button
                  onClick={() => open(c.id)}
                  className={`flex-1 truncate rounded px-2 py-1.5 text-left ${current === c.id ? 'bg-panel text-accent' : 'hover:bg-panel'}`}
                  title={c.title}
                >
                  {c.title}
                </button>
                <button onClick={() => remove(c)} className="px-1 text-xs text-muted opacity-0 group-hover:opacity-100" aria-label="Xóa">
                  ✕
                </button>
              </li>
            ))}
            {items.length === 0 && <li className="px-2 text-xs text-muted">Chưa có cuộc trò chuyện nào.</li>}
          </ul>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <h1 className="mb-3 text-xl font-semibold">Chat với MARIS</h1>
          <ChatPanel
            key={panelKey}
            conversationId={current}
            onConversationChange={(id) => {
              setCurrent(id);
              load();
            }}
          />
        </section>
      </div>
    </Shell>
  );
}
