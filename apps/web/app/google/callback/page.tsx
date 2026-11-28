'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { Notice } from '@/components/ui';
import { api } from '@/lib/api';
import { useMe } from '@/lib/useMe';

/** Google sends the person back here after sign-in; the code and state go on to the API once. */
function Callback() {
  const me = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const sent = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me || sent.current) return;
    sent.current = true;
    const code = params.get('code');
    const state = params.get('state') ?? '';
    // Take the code out of the address bar and browser history.
    window.history.replaceState(null, '', '/google/callback');
    if (!code) {
      setError(
        params.get('error_description') ??
          'Google không trả về mã đăng nhập. Có thể bạn đã bấm Hủy hoặc không cho phép.',
      );
      return;
    }
    api('/google/oauth/callback', { method: 'POST', body: JSON.stringify({ code, state }) })
      .then(() => router.replace('/google'))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Lỗi không xác định'));
  }, [me, params, router]);

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;

  return (
    <Shell me={me}>
      <h1 className="mb-4 text-xl font-semibold">Kết nối Google</h1>
      {error ? (
        <>
          <Notice kind="error">{error}</Notice>
          <Link href="/google" className="text-accent underline">
            Quay lại Trung tâm Google
          </Link>
        </>
      ) : (
        <p className="text-sm text-muted">Đang hoàn tất kết nối và đồng bộ kênh YouTube…</p>
      )}
    </Shell>
  );
}

export default function GoogleCallbackPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted">Đang tải…</div>}>
      <Callback />
    </Suspense>
  );
}
