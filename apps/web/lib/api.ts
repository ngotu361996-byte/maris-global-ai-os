import type { ApiError } from '@maris/contracts';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// Sprint 1: token in sessionStorage (cleared when the tab closes).
// Sprint 2 moves it to an httpOnly cookie behind a same-origin proxy.
const TOKEN_KEY = 'maris.token';
const TENANT_KEY = 'maris.tenant';

export const session = {
  token: () => (typeof window === 'undefined' ? null : sessionStorage.getItem(TOKEN_KEY)),
  tenant: () => (typeof window === 'undefined' ? null : sessionStorage.getItem(TENANT_KEY)),
  set(token: string) {
    sessionStorage.setItem(TOKEN_KEY, token);
  },
  setTenant(id: string) {
    sessionStorage.setItem(TENANT_KEY, id);
  },
  clear() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TENANT_KEY);
  },
};

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const token = session.token();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const tenant = session.tenant();
  if (tenant) headers.set('X-Tenant-Id', tenant);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as T | ApiError;
  if (!res.ok) {
    const err = (body as ApiError).error ?? { code: 'NETWORK', message: 'Không kết nối được API' };
    throw new ApiRequestError(res.status, err.code, err.message);
  }
  return body as T;
}
