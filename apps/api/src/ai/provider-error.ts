/**
 * Normalised provider failure. `retryable` errors may be retried on the same provider;
 * `failover` errors let the router move on to the next provider. A bad request
 * (our payload or the model name is wrong) does neither, so switching providers is never
 * used to get around one provider's refusal.
 */
export type ProviderErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'UPSTREAM'
  | 'BAD_REQUEST'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'BLOCKED_URL'
  | 'BAD_RESPONSE'
  | 'CANCELLED'
  | 'NO_KEY';

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(['RATE_LIMIT', 'UPSTREAM', 'TIMEOUT', 'NETWORK']);
const NO_FAILOVER: ReadonlySet<ProviderErrorCode> = new Set(['BAD_REQUEST', 'CANCELLED']);

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  get failover(): boolean {
    return !NO_FAILOVER.has(this.code);
  }
}

export function errorFromStatus(status: number, detail: string): ProviderError {
  const msg = `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 401 || status === 403) return new ProviderError('AUTH', msg, status);
  if (status === 429) return new ProviderError('RATE_LIMIT', msg, status);
  if (status === 408 || status >= 500) return new ProviderError('UPSTREAM', msg, status);
  return new ProviderError('BAD_REQUEST', msg, status);
}

export function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  return new ProviderError('NETWORK', e?.cause?.code ?? e?.message ?? 'network error');
}
