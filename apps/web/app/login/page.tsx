'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { SessionResponse } from '@maris/contracts';
import { api, ApiRequestError, session } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'bootstrap'>('login');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      const body =
        mode === 'login'
          ? { email: f.email, password: f.password, ...(f.totp ? { totp: f.totp } : {}) }
          : { email: f.email, password: f.password, displayName: f.displayName, tenantName: f.tenantName };
      await api<Partial<SessionResponse>>(mode === 'login' ? '/auth/login' : '/auth/bootstrap', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      session.clear();
      router.replace('/');
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'MFA_REQUIRED') setNeedTotp(true);
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    } finally {
      setBusy(false);
    }
  }

  const input = 'w-full rounded-md border border-line bg-bg px-3 py-2 text-sm';
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold text-accent">MARIS Command Center</h1>
        <p className="text-sm text-muted">{mode === 'login' ? 'Đăng nhập' : 'Khởi tạo chủ hệ thống (chỉ dùng một lần)'}</p>
        <input name="email" type="email" required placeholder="Email" className={input} autoComplete="username" />
        <input name="password" type="password" required minLength={mode === 'bootstrap' ? 12 : 1} placeholder="Mật khẩu" className={input} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        {mode === 'login' && needTotp && (
          <input name="totp" inputMode="numeric" pattern="\d{6}" placeholder="Mã 6 số từ ứng dụng xác thực" className={input} autoComplete="one-time-code" />
        )}
        {mode === 'bootstrap' && (
          <>
            <input name="displayName" required placeholder="Tên hiển thị" className={input} />
            <input name="tenantName" required placeholder="Tên doanh nghiệp (Tenant)" className={input} />
          </>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <button disabled={busy} className="w-full rounded-md bg-accent py-2 text-sm font-medium text-black disabled:opacity-60">
          {busy ? 'Đang xử lý…' : mode === 'login' ? 'Đăng nhập' : 'Khởi tạo'}
        </button>
        <button type="button" onClick={() => setMode(mode === 'login' ? 'bootstrap' : 'login')} className="w-full text-xs text-muted underline">
          {mode === 'login' ? 'Lần đầu cài đặt? Khởi tạo chủ hệ thống' : 'Đã có tài khoản? Đăng nhập'}
        </button>
      </form>
    </main>
  );
}
