import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) readonly config: AppConfig) {
    // BullMQ requires maxRetriesPerRequest: null on connections it uses.
    this.client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }

  /** A separate connection (BullMQ workers block on theirs). */
  duplicate(): Redis {
    return this.client.duplicate();
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

@Global()
@Module({ providers: [RedisService], exports: [RedisService] })
export class RedisModule {}
