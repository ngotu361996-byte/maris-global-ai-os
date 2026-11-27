import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.module';

const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 60_000;
const OPEN_MS = 30_000;

/**
 * Per-provider circuit breaker in Redis, shared by every API instance: after
 * FAILURE_THRESHOLD failures inside WINDOW_MS the provider is skipped for OPEN_MS,
 * then tried again. A success clears the failure count.
 */
@Injectable()
export class CircuitBreakerService {
  constructor(private readonly redis: RedisService) {}

  async isOpen(providerId: string): Promise<boolean> {
    return (await this.redis.client.exists(openKey(providerId))) === 1;
  }

  async openStates(providerIds: string[]): Promise<Set<string>> {
    if (!providerIds.length) return new Set();
    const flags = await this.redis.client.mget(...providerIds.map(openKey));
    return new Set(providerIds.filter((_, i) => flags[i] !== null));
  }

  async recordFailure(providerId: string): Promise<void> {
    const key = failKey(providerId);
    const [[, count]] = (await this.redis.client.multi().incr(key).pexpire(key, WINDOW_MS, 'NX').exec()) as [[unknown, number]];
    if (count >= FAILURE_THRESHOLD) {
      await this.redis.client.multi().set(openKey(providerId), '1', 'PX', OPEN_MS).del(key).exec();
    }
  }

  async recordSuccess(providerId: string): Promise<void> {
    await this.redis.client.del(failKey(providerId), openKey(providerId));
  }

  async reset(providerId: string): Promise<void> {
    await this.recordSuccess(providerId);
  }
}

const failKey = (id: string) => `ai:cb:fail:${id}`;
const openKey = (id: string) => `ai:cb:open:${id}`;
