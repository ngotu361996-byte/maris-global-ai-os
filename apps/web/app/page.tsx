'use client';

import Link from 'next/link';
import { Shell } from '@/components/Shell';
import { DASHBOARD_METRICS } from '@/lib/navigation';
import { useMe } from '@/lib/useMe';

export default function Home() {
  const me = useMe();
  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  return (
    <Shell me={me}>
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
      <p className="mt-6 text-sm text-muted">
        Để AI hoạt động ở Giai đoạn 3, hãy thêm API key vào <Link href="/secrets" className="text-accent underline">Secret Vault</Link>.
      </p>
    </Shell>
  );
}
