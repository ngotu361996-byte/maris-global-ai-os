import type {
  ClaimJobResponse,
  FinishJob,
  JobProgress,
  JobProgressResponse,
  DeviceInfo,
  Heartbeat,
  HeartbeatResponse,
  PairDeviceResponse,
} from '@maris/contracts';

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function post<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ServerError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `HTTP ${res.status}`,
    );
  }
  return data as T;
}

export function pair(
  server: string,
  pairing: string,
  info: DeviceInfo,
): Promise<PairDeviceResponse> {
  return post(`${server}/agent/pair`, { pairing, info });
}

export function heartbeat(
  server: string,
  token: string,
  body: Heartbeat,
): Promise<HeartbeatResponse> {
  return post(`${server}/agent/heartbeat`, body, { 'X-Maris-Device': token });
}

export function claimJob(server: string, token: string): Promise<ClaimJobResponse> {
  return post(`${server}/agent/jobs/claim`, {}, { 'X-Maris-Device': token });
}

export function jobProgress(
  server: string,
  token: string,
  id: string,
  body: JobProgress,
): Promise<JobProgressResponse> {
  return post(`${server}/agent/jobs/${id}/progress`, body, { 'X-Maris-Device': token });
}

export function finishJob(
  server: string,
  token: string,
  id: string,
  body: FinishJob,
): Promise<{ accepted: boolean }> {
  return post(`${server}/agent/jobs/${id}/finish`, body, { 'X-Maris-Device': token });
}
