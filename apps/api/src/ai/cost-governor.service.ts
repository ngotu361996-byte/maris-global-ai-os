import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import type { BudgetResponse, UpsertBudget } from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import type { Tx } from '../db/db.service';
import { OutboxService } from '../outbox/outbox.service';
import type { Candidate } from './ai-router.service';
import { AiProvidersService } from './ai-providers.service';
import type { Ctx } from './chat.service';

const { aiBudgets, aiProviderCalls } = schema;
type BudgetRow = typeof aiBudgets.$inferSelect;

export const ALERT_RATIO = 0.8;

/** Budgets run per calendar month in UTC. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
export function monthKey(now = new Date()): string {
  return monthStart(now).toISOString().slice(0, 7);
}

/**
 * Cost Governor: monthly USD budgets for the tenant and for single providers, measured from
 * ai.provider_calls (cost = tokens × the prices entered for the provider). A provider at 100% of
 * its budget is skipped; the tenant at 100% stops every AI call. Crossing 80% sends one alert a month.
 */
@Injectable()
export class CostGovernorService {
  constructor(
    private readonly providers: AiProvidersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(tx: Tx, tenantId: string): Promise<BudgetResponse[]> {
    const rows = await tx.select().from(aiBudgets).where(eq(aiBudgets.tenantId, tenantId));
    if (!rows.length) return [];
    const spent = await this.spent(tx, tenantId);
    return rows.map((b) => toResponse(b, spentFor(spent, b.providerId)));
  }

  async upsert(tx: Tx, ctx: Ctx, body: UpsertBudget): Promise<BudgetResponse> {
    if (body.providerId) await this.providers.get(tx, ctx.tenantId, body.providerId);
    const [row] = await tx
      .insert(aiBudgets)
      .values({ id: uuidv7(), tenantId: ctx.tenantId, providerId: body.providerId, monthlyUsd: String(body.monthlyUsd), createdBy: ctx.userId })
      .onConflictDoUpdate({
        target: [aiBudgets.tenantId, aiBudgets.providerId],
        // A new amount re-arms the 80% alert.
        set: { monthlyUsd: String(body.monthlyUsd), alertedMonth: null, updatedAt: new Date() },
      })
      .returning();
    await this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'ai.budget.set',
      targetType: 'ai_budget',
      targetId: row!.id,
      metadata: { providerId: body.providerId, monthlyUsd: body.monthlyUsd },
      ip: ctx.ip,
    });
    return toResponse(row!, spentFor(await this.spent(tx, ctx.tenantId), row!.providerId));
  }

  async remove(tx: Tx, ctx: Ctx, id: string): Promise<void> {
    const [row] = await tx.delete(aiBudgets).where(and(eq(aiBudgets.id, id), eq(aiBudgets.tenantId, ctx.tenantId))).returning();
    if (!row) throw new NotFoundException({ code: 'AI_BUDGET_NOT_FOUND', message: 'Không tìm thấy ngân sách' });
    await this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'ai.budget.removed',
      targetType: 'ai_budget',
      targetId: id,
      metadata: { providerId: row.providerId },
      ip: ctx.ip,
    });
  }

  /** Drops providers over budget; refuses when the tenant budget, or every provider's, is used up. */
  async filter(tx: Tx, tenantId: string, candidates: Candidate[]): Promise<Candidate[]> {
    const budgets = await tx.select().from(aiBudgets).where(eq(aiBudgets.tenantId, tenantId));
    if (!budgets.length) return candidates;
    const spent = await this.spent(tx, tenantId);
    const tenantBudget = budgets.find((b) => b.providerId === null);
    if (tenantBudget && spentFor(spent, null) >= Number(tenantBudget.monthlyUsd)) {
      throw new HttpException(
        { code: 'BUDGET_EXCEEDED', message: `Đã dùng hết ngân sách AI tháng này (${tenantBudget.monthlyUsd} USD). Tăng ngân sách ở trang AI Provider.` },
        402,
      );
    }
    const over = new Set(budgets.filter((b) => b.providerId && spentFor(spent, b.providerId) >= Number(b.monthlyUsd)).map((b) => b.providerId));
    const kept = candidates.filter((c) => !over.has(c.provider.id));
    if (candidates.length && !kept.length) {
      throw new HttpException({ code: 'BUDGET_EXCEEDED', message: 'Mọi AI đang bật đều đã dùng hết ngân sách tháng này.' }, 402);
    }
    return kept;
  }

  /** Sends the 80% alert once per budget per month. Call after recording new spending. */
  async afterSpend(tx: Tx, tenantId: string): Promise<void> {
    const month = monthKey();
    const budgets = await tx.select().from(aiBudgets).where(eq(aiBudgets.tenantId, tenantId));
    const due = budgets.filter((b) => b.alertedMonth !== month);
    if (!due.length) return;
    const spent = await this.spent(tx, tenantId);
    for (const b of due) {
      const used = spentFor(spent, b.providerId);
      if (used < Number(b.monthlyUsd) * ALERT_RATIO) continue;
      await tx.update(aiBudgets).set({ alertedMonth: month, updatedAt: new Date() }).where(eq(aiBudgets.id, b.id));
      await this.outbox.enqueue(tx, {
        tenantId,
        type: 'ai.budget.threshold_reached',
        payload: { budgetId: b.id, providerId: b.providerId, month, spentUsd: round(used), monthlyUsd: Number(b.monthlyUsd), ratio: ALERT_RATIO },
      });
    }
  }

  /** This month's spend per provider; key null holds the tenant total. */
  private async spent(tx: Tx, tenantId: string): Promise<Map<string | null, number>> {
    const rows = await tx
      .select({ providerId: aiProviderCalls.providerId, total: sql<string>`coalesce(sum(${aiProviderCalls.costUsd}), 0)` })
      .from(aiProviderCalls)
      .where(and(eq(aiProviderCalls.tenantId, tenantId), gte(aiProviderCalls.createdAt, monthStart())))
      .groupBy(aiProviderCalls.providerId);
    const map = new Map<string | null, number>();
    let total = 0;
    for (const r of rows) {
      map.set(r.providerId, Number(r.total));
      total += Number(r.total);
    }
    map.set(null, total);
    return map;
  }
}

function spentFor(spent: Map<string | null, number>, providerId: string | null): number {
  return spent.get(providerId) ?? 0;
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function toResponse(b: BudgetRow, spentUsd: number): BudgetResponse {
  const monthly = Number(b.monthlyUsd);
  const ratio = monthly > 0 ? spentUsd / monthly : 0;
  return {
    id: b.id,
    providerId: b.providerId,
    monthlyUsd: monthly,
    spentUsd: round(spentUsd),
    ratio: Math.round(ratio * 1000) / 1000,
    state: ratio >= 1 ? 'exceeded' : ratio >= ALERT_RATIO ? 'warning' : 'ok',
    month: monthKey(),
  };
}
