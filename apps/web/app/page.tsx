'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeResponse } from '@maris/contracts';
import { api, session } from '@/lib/api';
import { Shell } from '@/components/Shell';

export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    if (!session.token()) {
      router.replace('/login');
      return;
    }
    api<MeResponse>('/auth/me')
      .then((m) => {
        if (m.memberships[0]) session.setTenant(m.memberships[0].tenantId);
        setMe(m);
      })
      .catch(() => {
        session.clear();
        router.replace('/login');
      });
  }, [router]);

  if (!me) return <div className="p-8 text-sm text-muted">Đang tải…</div>;
  return (
    <Shell
      me={me}
      onLogout={async () => {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        session.clear();
        router.replace('/login');
      }}
    />
  );
}
