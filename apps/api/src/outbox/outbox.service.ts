import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { asc, inArray, isNull, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { RedisService } from '../redis/redis.module';

const { outboxEvents } = schema;
export const EVENTS_QUEUE = 'maris-events';

export interface OutboxEvent {
  tenantId: string;
  /** <module>.<object>.<past tense>, e.g. identity.member.added */
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Transactional outbox: events are written in the same transaction as the change,
 * then a relay publishes them to BullMQ. A crash between the two never loses an event;
 * consumers must be idempotent because an event can be delivered more than once.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Outbox');
  private queue?: Queue;
  private queueConnection?: Redis;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async enqueue(tx: Tx, event: OutboxEvent): Promise<void> {
    await tx.insert(outboxEvents).values({
      id: uuidv7(),
      tenantId: event.tenantId,
      type: event.type,
      payload: event.payload ?? {},
    });
  }

  /** Publishes up to `limit` pending events. Returns how many were published. */
  async relayOnce(limit = 100): Promise<number> {
    const queue = this.getQueue();
    return this.db.withSystem('outbox_relay', async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.publishedAt))
        .orderBy(asc(outboxEvents.createdAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (!rows.length) return 0;
      // jobId = event id, so a re-run after a crash does not enqueue a duplicate job.
      await queue.addBulk(
        rows.map((r) => ({
          name: r.type,
          data: { id: r.id, tenantId: r.tenantId, type: r.type, payload: r.payload, createdAt: r.createdAt.toISOString() },
          opts: { jobId: r.id, attempts: 5, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000 },
        })),
      );
      await tx
        .update(outboxEvents)
        .set({ publishedAt: new Date(), attempts: sql`${outboxEvents.attempts} + 1` })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((r) => r.id),
          ),
        );
      return rows.length;
    });
  }

  onModuleInit(): void {
    if (!this.config.OUTBOX_RELAY_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.queue?.close();
    // BullMQ does not close a connection it was handed, so close ours.
    await this.queueConnection?.quit().catch(() => undefined);
  }

  private getQueue(): Queue {
    if (!this.queue) {
      this.queueConnection = this.redis.duplicate();
      this.queue = new Queue(EVENTS_QUEUE, { connection: this.queueConnection });
    }
    return this.queue;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while ((await this.relayOnce()) === 100) {
        /* drain */
      }
    } catch (err) {
      this.logger.error(`Relay failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
