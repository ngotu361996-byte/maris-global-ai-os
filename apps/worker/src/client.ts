import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  ClaimJobResponse,
  FinishJob,
  JobProgress,
  JobProgressResponse,
  MediaOutputResponse,
  DeviceInfo,
  Heartbeat,
  HeartbeatResponse,
  PairDeviceResponse,
} from '@maris/contracts';

/** Longest a video download or upload may take. */
const DOWNLOAD_MAX_MS = 60 * 60 * 1000;

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function fail(res: Response): Promise<never> {
  const text = await res.text().catch(() => '');
  let err: { code?: string; message?: string } | undefined;
  try {
    err = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
  } catch {
    /* not JSON */
  }
  throw new ServerError(
    res.status,
    err?.code ?? 'HTTP_ERROR',
    err?.message ?? `HTTP ${res.status}`,
  );
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

/** Fetches an image (or logo) of a job this worker runs, refusing anything over maxBytes. */
export async function downloadJobFile(
  server: string,
  token: string,
  jobId: string,
  assetId: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const res = await fetch(`${server}/agent/jobs/${jobId}/files/${assetId}`, {
    headers: { 'X-Maris-Device': token },
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  if (!res.ok) return fail(res);
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes)
    throw new ServerError(413, 'FILE_TOO_LARGE', 'Tệp quá lớn');
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > maxBytes) throw new ServerError(413, 'FILE_TOO_LARGE', 'Tệp quá lớn');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** Sends one output image of a job; sending the same preset again is safe. */
export async function uploadJobOutput(
  server: string,
  token: string,
  jobId: string,
  preset: string,
  fileName: string,
  data: Buffer,
  signal: AbortSignal,
): Promise<MediaOutputResponse> {
  const res = await fetch(
    `${server}/agent/jobs/${jobId}/outputs?preset=${encodeURIComponent(preset)}`,
    {
      method: 'POST',
      headers: {
        'X-Maris-Device': token,
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(fileName),
      },
      body: new Uint8Array(data),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    },
  );
  if (!res.ok) return fail(res);
  return (await res.json()) as MediaOutputResponse;
}

/** Saves a (large) file of a job this worker runs to disk, refusing anything over maxBytes. */
export async function downloadJobFileTo(
  server: string,
  token: string,
  jobId: string,
  what: { assetId: string } | { itemId: string },
  dest: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<number> {
  const path = 'assetId' in what ? `files/${what.assetId}` : `items/${what.itemId}`;
  const res = await fetch(`${server}/agent/jobs/${jobId}/${path}`, {
    headers: { 'X-Maris-Device': token },
    signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MAX_MS)]),
  });
  if (!res.ok) return fail(res);
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes)
    throw new ServerError(413, 'FILE_TOO_LARGE', 'Tệp quá lớn');
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > maxBytes) done(new ServerError(413, 'FILE_TOO_LARGE', 'Tệp quá lớn'));
      else done(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    limit,
    createWriteStream(dest),
  );
  return size;
}

/** Sends one output file of a job from disk; sending the same preset again is safe. */
export async function uploadJobOutputFile(
  server: string,
  token: string,
  jobId: string,
  preset: string,
  fileName: string,
  file: string,
  signal: AbortSignal,
): Promise<MediaOutputResponse> {
  const { size } = await stat(file);
  const res = await fetch(
    `${server}/agent/jobs/${jobId}/outputs?preset=${encodeURIComponent(preset)}`,
    {
      method: 'POST',
      headers: {
        'X-Maris-Device': token,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'X-File-Name': encodeURIComponent(fileName),
      },
      body: Readable.toWeb(createReadStream(file)) as unknown as RequestInit['body'],
      duplex: 'half',
      signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MAX_MS)]),
    } as RequestInit,
  );
  if (!res.ok) return fail(res);
  return (await res.json()) as MediaOutputResponse;
}
