'use client';

import { useState } from 'react';
import type { MeResponse } from '@maris/contracts';
import { DASHBOARD_METRICS, NAV_GROUPS } from '@/lib/navigation';

/** Bố cục 5 vùng: sidebar trái, topbar, khu giữa, sidebar phải (AI Chat), drawer dưới. */
export function Shell({ me, onLogout }: { me: MeResponse; onLogout: () => void }) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [chatOpen, setChatOpen] = useState(true);
  const tenant = me.memberships[0];

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
          title="Dừng khẩn cấp: kích hoạt ở Giai đoạn 3 khi có tác vụ AI"
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
            {g.items.map((i) => (
              <div key={i.code} className="flex justify-between rounded px-2 py-1 text-muted">
                <span>{i.name}</span>
                <span className="whitespace-nowrap text-[10px]">Chưa có</span>
              </div>
            ))}
          </div>
        ))}
      </nav>

      {/* Khu giữa + sidebar phải */}
      <div className="flex min-h-0 overflow-hidden">
        <main className="flex-1 overflow-y-auto p-6">
          <h1 className="mb-1 text-xl font-semibold">Xin chào, {me.displayName}</h1>
          <p className="mb-6 text-sm text-muted">
            Bảng điều khiển chính. Ô chưa có nguồn dữ liệu hiển thị “Chưa kết nối”; hệ thống không bao giờ điền số mẫu.
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            {DASHBOARD_METRICS.map((m) => (
              <div key={m} className="rounded-lg border border-line bg-panel p-3">
                <div className="text-xs text-muted">{m}</div>
                <div className="mt-2 text-sm font-medium text-muted">Chưa kết nối</div>
              </div>
            ))}
          </div>
          {!me.mfaEnabled && (
            <p className="mt-6 rounded-md border border-accent p-3 text-sm">
              Bạn chưa bật xác thực 2 lớp (MFA). Nên bật trước khi kết nối tài khoản kinh doanh.
            </p>
          )}
        </main>
        {chatOpen && (
          <aside className="w-80 border-l border-line bg-panel p-4 text-sm max-lg:hidden" aria-label="AI Chat">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">AI Chat</span>
              <button onClick={() => setChatOpen(false)} className="text-xs text-muted">
                Thu gọn
              </button>
            </div>
            <p className="text-muted">Chưa kích hoạt. AI Chat được xây ở Giai đoạn 3 sau khi bạn thêm API key vào Secret Vault.</p>
          </aside>
        )}
      </div>

      {/* Drawer dưới */}
      <section className="overflow-y-auto border-t border-line bg-panel p-3 text-xs text-muted max-md:hidden" aria-label="Công việc đang chạy">
        <div className="mb-1 font-medium text-ink">Công việc đang chạy</div>
        Không có công việc nào. Hàng đợi và tiến độ thời gian thực bật ở Giai đoạn 3.
      </section>
    </div>
  );
}
