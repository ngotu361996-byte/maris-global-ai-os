'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { btnCls, inputCls, Notice } from '@/components/ui';
import { api, ApiRequestError, session } from '@/lib/api';

/** The token travels in the URL fragment, which browsers never send to any server or put in logs. */
export default function InvitePage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [needSignIn, setNeedSignIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setToken(window.location.hash.slice(1));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    try {
      await api('/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ token, displayName: f.get('displayName') || undefined, password: f.get('password') || undefined }),
      });
      session.clear();
      setDone(true);
      setTimeout(() => router.replace('/'), 800);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'SIGN_IN_REQUIRED') setNeedSignIn(true);
      setError(err instanceof Error ? err.message : 'Lỗi không xác định');
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-panel p-6">
        <h1 className="text-lg font-semibold text-accent">Nhận lời mời vào MARIS</h1>
        {!token && <Notice kind="error">Đường dẫn thiếu mã lời mời.</Notice>}
        {done && <Notice kind="ok">Đã vào Tenant. Đang chuyển trang…</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {needSignIn ? (
          <p className="text-sm">
            Email này đã có tài khoản. <a href="/login" className="text-accent underline">Đăng nhập</a>, rồi mở lại đường dẫn lời mời này.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">Lần đầu dùng MARIS? Đặt tên và mật khẩu (từ 12 ký tự).</p>
            <input name="displayName" placeholder="Tên hiển thị" className={inputCls} />
            <input name="password" type="password" minLength={12} placeholder="Mật khẩu" className={inputCls} autoComplete="new-password" />
          </>
        )}
        <button disabled={!token || done} className={`${btnCls} w-full`}>
          Nhận lời mời
        </button>
        <p className="text-xs text-muted">Nếu đã đăng nhập bằng đúng email được mời, chỉ cần bấm Nhận lời mời.</p>
      </form>
    </main>
  );
}
