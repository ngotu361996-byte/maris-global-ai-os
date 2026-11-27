'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { MeResponse } from '@maris/contracts';
import { api, session } from '@/lib/api';
import { NAV_GROUPS } from '@/lib/navigation';
import { ChatPanel } from '@/components/ChatPanel';

/** Bố cục 5 vùng: sidebar trái, topbar, khu giữa, sidebar phải (AI Chat), drawer dưới. */
export function Shell({ me, children, hideChat }: { me: MeResponse; children: React.ReactNode; hideChat?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const onLogout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    session.clear();
    router.replace('/login');
  };
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [chatOpen, setChatOpen] = useState(true);
  // Bumping the key starts a fresh conversation in the side panel; full history lives on /chat.
  const [sideKey, setSideKey] = useState(0);
  const tenant = me.memberships[0];
  const canChat = !!tenant;

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };

  return (
    <div className="grid h-screen grid-cols-[240px_1fr] grid-rows-[56px_1fr_160px] max-md:grid-cols-1">
      {/* Topbar */}
      <header className="col-span-2 flex items-center gap-3 border-b border-line bg-panel px-4 max-md:col-span-1">
        <span className="font-semibold tracking-wide text-accent">MARIS</span>
        <input
          className="ml-4 w-72 rounded-md border border-line bg-bg px-3 py-1.5 text-sm max-md:hidden"
          placeholder="Tìm lệnh (Ctrl+K)"
          aria-label="Tìm lệnh"
        />
        <span className="ml-auto text-sm text-muted">{tenant ? `${tenant.tenantName} · ${tenant.role}` : 'Chưa có Tenant'}</span>
        <span className="flex items-center gap-1 text-xs text-muted" title="Trạng thái hệ thống">
          <span className="h-2 w-2 rounded-full bg-green-500" /> API
        </span>
        <button onClick={toggleTheme} className="rounded-md border border-line px-2 py-1 text-xs">
          {theme === 'dark' ? 'Sáng' : 'Tối'}
        </button>
        <button
          disabled
          title="Dừng khẩn cấp: kích hoạt ở Sprint 5 cùng Structured Task. Muốn dừng một câu trả lời đang chạy, bấm Dừng trong khung chat."
          className="rounded-md border border-danger px-2 py-1 text-xs text-danger opacity-60"
        >
          Dừng khẩn cấp
        </button>
        <button onClick={onLogout} className="text-xs text-muted underline">
          Đăng xuất
        </button>
      </header>

      {/* Sidebar trái */}
      <nav className="row-span-2 overflow-y-auto border-r border-line bg-panel p-3 text-sm max-md:hidden" aria-label="Trung tâm">
        {NAV_GROUPS.map((g) => (
          <div key={g.title} className="mb-4">
            <div className="mb-1 text-xs uppercase tracking-wider text-muted">{g.title}</div>
            {g.items.map((i) =>
              i.href ? (
                <Link
                  key={i.code}
                  href={i.href}
                  className={`block rounded px-2 py-1 ${pathname === i.href ? 'bg-bg text-accent' : 'text-ink hover:bg-bg'}`}
                >
                  {i.name}
                </Link>
              ) : (
                <div key={i.code} className="flex justify-between rounded px-2 py-1 text-muted">
                  <span>{i.name}</span>
                  <span className="whitespace-nowrap text-[10px]">Chưa có</span>
                </div>
              ),
            )}
          </div>
        ))}
      </nav>

      {/* Khu giữa + sidebar phải */}
      <div className="flex min-h-0 overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
        {!hideChat && canChat && chatOpen && (
          <aside className="flex w-80 flex-col border-l border-line bg-panel p-4 text-sm max-lg:hidden" aria-label="AI Chat">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">AI Chat</span>
              <span className="flex gap-3">
                <button onClick={() => setSideKey((k) => k + 1)} className="text-xs text-muted" title="Bắt đầu cuộc trò chuyện mới">
                  Mới
                </button>
                <Link href="/chat" className="text-xs text-muted">
                  Mở rộng
                </Link>
                <button onClick={() => setChatOpen(false)} className="text-xs text-muted">
                  Thu gọn
                </button>
              </span>
            </div>
            <ChatPanel key={sideKey} conversationId={null} compact />
          </aside>
        )}
        {!hideChat && canChat && !chatOpen && (
          <button onClick={() => setChatOpen(true)} className="border-l border-line bg-panel px-2 text-xs text-muted max-lg:hidden" title="Mở AI Chat">
            AI
          </button>
        )}
      </div>

      {/* Drawer dưới */}
      <section className="overflow-y-auto border-t border-line bg-panel p-3 text-xs text-muted max-md:hidden" aria-label="Công việc đang chạy">
        <div className="mb-1 font-medium text-ink">Công việc đang chạy</div>
        Không có công việc nào. Giao việc có phê duyệt và tiến độ thời gian thực bật ở Sprint 5.
      </section>
    </div>
  );
}
