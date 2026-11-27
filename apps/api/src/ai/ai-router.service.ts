import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatStreamEvent } from '@maris/contracts';
import { schema } from '@maris/db';
import { APP_CONFIG, type AppConfig } from '../config';
import { adapterFor, baseUrlFor, type ChatTurn, type StreamUsage } from './adapters';
import { CircuitBreakerService } from './circuit-breaker.service';
import { ProviderError, toProviderError } from './provider-error';
import { assertAllowedProviderUrl } from './url-guard';

export type ProviderRow = typeof schema.aiProviders.$inferSelect;

export interface Candidate {
  provider: ProviderRow;
  model: string;
}

export interface CallRecord {
  providerId: string;
  model: string;
  outcome: 'ok' | 'error' | 'timeout' | 'circuit_open' | 'cancelled';
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
}

export interface RouteResult {
  status: 'complete' | 'error' | 'cancelled';
  content: string;
  provider: ProviderRow | null;
  model: string | null;
  usage: StreamUsage;
  costUsd: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  calls: CallRecord[];
}

export interface RouteInput {
  candidates: Candidate[];
  messages: ChatTurn[];
  signal: AbortSignal;
  emit: (event: ChatStreamEvent) => void;
  /** Decrypts the provider's key from the Secret Vault; never logged or returned. */
  resolveKey: (provider: ProviderRow) => Promise<string | null>;
}

const ATTEMPTS_PER_PROVIDER = 2;

/**
 * AI Router with failover: tries candidates in order, retrying transient errors with
 * backoff, skipping providers whose circuit is open. It only fails over before the
 * first piece of text arrives; once text has streamed, a failure ends the reply with
 * what was received, so nothing is answered twice.
 */
@Injectable()
export class AiRouterService {
  private readonly logger = new Logger('AiRouter');

  constructor(
    private readonly breaker: CircuitBreakerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async route(input: RouteInput): Promise<RouteResult> {
    const calls: CallRecord[] = [];
    let last: ProviderError | null = null;

    for (const { provider, model } of input.candidates) {
      if (await this.breaker.isOpen(provider.id)) {
        calls.push(record(provider.id, model, 'circuit_open', 'CIRCUIT_OPEN'));
        last = new ProviderError('UPSTREAM', `${provider.name} đang tạm ngắt do lỗi liên tiếp`);
        continue;
      }
      input.emit({ type: 'provider', providerId: provider.id, name: provider.name, model });

      for (let attempt = 1; attempt <= ATTEMPTS_PER_PROVIDER; attempt++) {
        const started = Date.now();
        let content = '';
        try {
          const usage = await this.attempt(provider, model, input, (text) => {
            content += text;
            input.emit({ type: 'delta', text });
          });
          const latencyMs = Date.now() - started;
          const costUsd = cost(provider, usage);
          calls.push({ ...record(provider.id, model, 'ok', null), ...usage, costUsd, latencyMs });
          await this.breaker.recordSuccess(provider.id);
          return { status: 'complete', content, provider, model, usage, costUsd, latencyMs, errorCode: null, errorMessage: null, calls };
        } catch (raw) {
          const err = toProviderError(raw);
          const latencyMs = Date.now() - started;
          const outcome = err.code === 'CANCELLED' ? 'cancelled' : err.code === 'TIMEOUT' ? 'timeout' : 'error';
          calls.push({ ...record(provider.id, model, outcome, err.code), latencyMs });
          if (err.code !== 'CANCELLED' && err.code !== 'BAD_REQUEST') await this.breaker.recordFailure(provider.id);
          this.logger.warn(`provider ${provider.id} (${provider.kind}) attempt ${attempt} failed: ${err.code}`);

          // Text already reached the user: stop here rather than answer again elsewhere.
          if (content || err.code === 'CANCELLED' || !err.failover) {
            return {
              status: err.code === 'CANCELLED' ? 'cancelled' : 'error',
              content,
              provider,
              model,
              usage: { inputTokens: null, outputTokens: null },
              costUsd: null,
              latencyMs,
              errorCode: err.code,
              errorMessage: err.message,
              calls,
            };
          }
          last = err;
          if (!err.retryable || attempt === ATTEMPTS_PER_PROVIDER) break;
          await sleep(this.config.AI_RETRY_BASE_MS * 2 ** (attempt - 1), input.signal);
          if (input.signal.aborted) break;
        }
      }
      if (input.signal.aborted) break;
      input.emit({ type: 'failover', fromProviderId: provider.id, errorCode: last?.code ?? 'UPSTREAM' });
    }

    const cancelled = input.signal.aborted;
    return {
      status: cancelled ? 'cancelled' : 'error',
      content: '',
      provider: null,
      model: null,
      usage: { inputTokens: null, outputTokens: null },
      costUsd: null,
      latencyMs: null,
      errorCode: cancelled ? 'CANCELLED' : input.candidates.length ? 'ALL_PROVIDERS_FAILED' : 'NO_PROVIDER',
      errorMessage: cancelled
        ? 'Đã hủy'
        : input.candidates.length
          ? `Tất cả AI Provider đều lỗi${last ? ` (lỗi cuối: ${last.code})` : ''}`
          : 'Chưa có AI Provider nào được bật',
      calls,
    };
  }

  /** One call to one provider, with an idle timeout that restarts whenever text arrives. */
  private async attempt(provider: ProviderRow, model: string, input: RouteInput, onText: (t: string) => void): Promise<StreamUsage> {
    const baseUrl = baseUrlFor(provider.kind, provider.baseUrl);
    await assertAllowedProviderUrl(baseUrl, { kind: provider.kind, allowPrivate: this.config.AI_ALLOW_PRIVATE_URLS });
    const apiKey = await input.resolveKey(provider);

    const ctrl = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, provider.timeoutMs);
    };
    const onAbort = () => ctrl.abort();
    if (input.signal.aborted) throw new ProviderError('CANCELLED', 'Đã hủy');
    input.signal.addEventListener('abort', onAbort, { once: true });
    arm();
    try {
      return await adapterFor(provider.kind).stream(
        { kind: provider.kind, baseUrl, apiKey, model },
        input.messages,
        (text) => {
          arm();
          onText(text);
        },
        ctrl.signal,
      );
    } catch (err) {
      if (input.signal.aborted) throw new ProviderError('CANCELLED', 'Đã hủy');
      if (timedOut) throw new ProviderError('TIMEOUT', `Quá ${provider.timeoutMs} ms không có phản hồi`);
      throw err;
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
    }
  }
}

function record(providerId: string, model: string, outcome: CallRecord['outcome'], errorCode: string | null): CallRecord {
  return { providerId, model, outcome, errorCode, inputTokens: null, outputTokens: null, costUsd: null, latencyMs: null };
}

export function cost(provider: Pick<ProviderRow, 'inputCostPerMtok' | 'outputCostPerMtok'>, usage: StreamUsage): number | null {
  if (provider.inputCostPerMtok == null && provider.outputCostPerMtok == null) return null;
  const i = (usage.inputTokens ?? 0) * Number(provider.inputCostPerMtok ?? 0);
  const o = (usage.outputTokens ?? 0) * Number(provider.outputCostPerMtok ?? 0);
  return Math.round(((i + o) / 1_000_000) * 1e6) / 1e6;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}
