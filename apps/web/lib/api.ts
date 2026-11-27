import type { ApiError } from '@maris/contracts';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

// The session lives in an httpOnly cookie set by the API, so page scripts never see the token.
// Only the chosen tenant id (not a secret) is kept in sessionStorage.
const TENANT_KEY = 'maris.tenant';

export const session = {
  tenant: () => (typeof window === 'undefined' ? null : sessionStorage.getItem(TENANT_KEY)),
  setTenant(id: string) {
    sessionStorage.setItem(TENANT_KEY, id);
  },
  clear() {
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
  headers.set('X-MARIS-Session', 'cookie');
  headers.set('X-MARIS-CSRF', '1');
  const tenant = session.tenant();
  if (tenant) headers.set('X-Tenant-Id', tenant);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as T | ApiError;
  if (!res.ok) {
    const err = (body as ApiError).error ?? { code: 'NETWORK', message: 'Không kết nối được API' };
    throw new ApiRequestError(res.status, err.code, err.message);
  }
  return body as T;
}

/**
 * POSTs to a streaming endpoint and calls onEvent for each server-sent event (one JSON object
 * per `data:` line). Errors before the stream starts throw ApiRequestError like api().
 */
export async function apiStream<E>(path: string, body: unknown, onEvent: (event: E) => void, signal?: AbortSignal): Promise<void> {
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-MARIS-Session': 'cookie', 'X-MARIS-CSRF': '1' });
  const tenant = session.tenant();
  if (tenant) headers.set('X-Tenant-Id', tenant);
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'include', signal });
  if (!res.ok || !res.body) {
    const err = ((await res.json().catch(() => ({}))) as ApiError).error ?? { code: 'NETWORK', message: 'Không kết nối được API' };
    throw new ApiRequestError(res.status, err.code, err.message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (data) onEvent(JSON.parse(data) as E);
    }
  }
}

/** Uploads one file as the raw body; the server detects its type from the content. */
export async function uploadFile<T>(file: File): Promise<T> {
  return uploadTo<T>('/ai/files', file);
}

/** Uploads one file as the raw body to any upload endpoint (path may carry query parameters). */
export async function uploadTo<T>(path: string, file: File): Promise<T> {
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'X-File-Name': encodeURIComponent(file.name),
    'X-MARIS-Session': 'cookie',
    'X-MARIS-CSRF': '1',
  });
  const tenant = session.tenant();
  if (tenant) headers.set('X-Tenant-Id', tenant);
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers, body: file, credentials: 'include' });
  const body = (await res.json().catch(() => ({}))) as T | ApiError;
  if (!res.ok) {
    const err = (body as ApiError).error ?? { code: 'NETWORK', message: 'Không kết nối được API' };
    throw new ApiRequestError(res.status, err.code, err.message);
  }
  return body as T;
}

/** Downloads a file the session may read and returns a local object URL (revoke it when done). */
export async function fileUrl(path: string): Promise<string> {
  const headers = new Headers({ 'X-MARIS-Session': 'cookie', 'X-MARIS-CSRF': '1' });
  const tenant = session.tenant();
  if (tenant) headers.set('X-Tenant-Id', tenant);
  const res = await fetch(`${API_URL}${path}`, { headers, credentials: 'include' });
  if (!res.ok) throw new ApiRequestError(res.status, 'FILE', 'Không tải được tệp');
  return URL.createObjectURL(await res.blob());
}
