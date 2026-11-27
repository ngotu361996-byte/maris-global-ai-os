import { HttpException, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@maris/db';
import type { AiControlResponse } from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import type { Tx } from '../db/db.service';
import { OutboxService } from '../outbox/outbox.service';
import { RedisService } from '../redis/redis.module';
import type { Ctx } from './chat.service';

const { aiControls, aiTasks } = schema;

export const estopKey = (tenantId: string) => `ai:estop:${tenantId}`;
export const taskAbortKey = (taskId: string) => `ai:task:abort:${taskId}`;
const WATCH_MS = 500;

/**
 * Emergency stop. The database row is the source of truth and is checked before any AI call;
 * a Redis flag lets every API instance abort replies and tasks that are already running.
 */
@Injectable()
export class ControlService {
  constructor(
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async state(tx: Tx, tenantId: string): Promise<AiControlResponse> {
    const [row] = await tx.select().from(aiControls).where(eq(aiControls.tenantId, tenantId));
    return { emergencyStop: row?.emergencyStop ?? false, reason: row?.reason ?? null, changedAt: row?.changedAt.toISOString() ?? null };
  }

  async assertRunning(tx: Tx, tenantId: string): Promise<void> {
    if ((await this.state(tx, tenantId)).emergencyStop) {
      throw new HttpException({ code: 'EMERGENCY_STOP', message: 'MARIS đang Dừng khẩn cấp. Người có quyền phê duyệt cần bật lại AI.' }, 423);
    }
  }

  /** Stops all AI work in the tenant: new calls are refused, running replies and tasks are aborted, open tasks are paused. */
  async stop(tx: Tx, ctx: Ctx, reason: string | null): Promise<AiControlResponse> {
    await this.upsert(tx, ctx, true, reason);
    const paused = await tx
      .update(aiTasks)
      .set({ status: 'paused', progress: 'Tạm dừng do Dừng khẩn cấp', updatedAt: new Date() })
      .where(and(eq(aiTasks.tenantId, ctx.tenantId), inArray(aiTasks.status, ['queued', 'running'])))
      .returning({ id: aiTasks.id });
    await this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'ai.emergency_stop.activated',
      targetType: 'tenant',
      targetId: ctx.tenantId,
      metadata: { reason, pausedTasks: paused.length },
      ip: ctx.ip,
    });
    await this.outbox.enqueue(tx, { tenantId: ctx.tenantId, type: 'ai.emergency_stop.activated', payload: { pausedTasks: paused.length } });
    return this.state(tx, ctx.tenantId);
  }

  async resume(tx: Tx, ctx: Ctx): Promise<AiControlResponse> {
    await this.upsert(tx, ctx, false, null);
    await this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'ai.emergency_stop.released',
      targetType: 'tenant',
      targetId: ctx.tenantId,
      ip: ctx.ip,
    });
    await this.outbox.enqueue(tx, { tenantId: ctx.tenantId, type: 'ai.emergency_stop.released' });
    return this.state(tx, ctx.tenantId);
  }

  /** Call after the stop/resume transaction commits, so the flag never runs ahead of the database. */
  async publish(tenantId: string, stopped: boolean): Promise<void> {
    if (stopped) await this.redis.client.set(estopKey(tenantId), '1');
    else await this.redis.client.del(estopKey(tenantId));
  }

  /** Aborts `ctrl` when any of the Redis flags appears. Returns a function that stops watching. */
  watch(keys: string[], ctrl: AbortController): () => void {
    const timer = setInterval(() => {
      this.redis.client
        .exists(...keys)
        .then((n) => {
          if (n > 0 && !ctrl.signal.aborted) ctrl.abort();
        })
        .catch(() => undefined);
    }, WATCH_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async upsert(tx: Tx, ctx: Ctx, stop: boolean, reason: string | null): Promise<void> {
    await tx
      .insert(aiControls)
      .values({ tenantId: ctx.tenantId, emergencyStop: stop, reason, changedBy: ctx.userId, changedAt: new Date() })
      .onConflictDoUpdate({ target: aiControls.tenantId, set: { emergencyStop: stop, reason, changedBy: ctx.userId, changedAt: new Date() } });
  }
}
