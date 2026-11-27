'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeResponse } from '@maris/contracts';
import { api, session } from './api';

/** Loads the signed-in user; sends to /login when there is no valid session. */
export function useMe(): MeResponse | null {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    api<MeResponse>('/auth/me')
      .then((m) => {
        if (m.memberships[0] && !session.tenant()) session.setTenant(m.memberships[0].tenantId);
        setMe(m);
      })
      .catch(() => {
        session.clear();
        router.replace('/login');
      });
  }, [router]);
  return me;
}
