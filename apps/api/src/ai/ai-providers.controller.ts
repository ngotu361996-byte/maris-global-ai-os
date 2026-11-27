import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@maris/db';
import {
  createAiProviderSchema,
  reorderAiProvidersSchema,
  updateAiProviderSchema,
  type AiProviderResponse,
  type AiProviderTestResult,
  type AiUsageResponse,
  type CreateAiProvider,
  type ReorderAiProviders,
  type UpdateAiProvider,
} from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import { AuthGuard } from '../auth/auth.guard';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { OutboxService } from '../outbox/outbox.service';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { AiProvidersService } from './ai-providers.service';

const { aiProviderCalls, aiProviders } = schema;
const usageQuery = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) });

@Controller('ai')
@UseGuards(AuthGuard, TenantGuard)
export class AiProvidersController {
  constructor(
    private readonly db: DbService,
    private readonly providers: AiProvidersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  @Get('providers')
  @RequirePermission('ai.chat')
  list(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext): Promise<AiProviderResponse[]> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, (tx) => this.providers.list(tx, tenant.id));
  }

  @Post('providers')
  @RequirePermission('ai.manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createAiProviderSchema)) body: CreateAiProvider,
    @Req() req: Request,
  ): Promise<AiProviderResponse> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const created = await this.providers.create(tx, tenant.id, user.id, body);
      await this.audit.append(tx, {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'ai.provider.created',
        targetType: 'ai_provider',
        targetId: created.id,
        metadata: { name: created.name, kind: created.kind, model: created.defaultModel },
        ip: clientIp(req),
      });
      await this.outbox.enqueue(tx, { tenantId: tenant.id, type: 'ai.provider.created', payload: { providerId: created.id, kind: created.kind } });
      return created;
    });
  }

  @Patch('providers/:id')
  @RequirePermission('ai.manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateAiProviderSchema)) body: UpdateAiProvider,
    @Req() req: Request,
  ): Promise<AiProviderResponse> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const updated = await this.providers.update(tx, tenant.id, id, body);
      await this.audit.append(tx, {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'ai.provider.updated',
        targetType: 'ai_provider',
        targetId: id,
        metadata: { fields: Object.keys(body) },
        ip: clientIp(req),
      });
      await this.outbox.enqueue(tx, { tenantId: tenant.id, type: 'ai.provider.updated', payload: { providerId: id, fields: Object.keys(body) } });
      return updated;
    });
  }

  @Delete('providers/:id')
  @HttpCode(204)
  @RequirePermission('ai.manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const row = await this.providers.remove(tx, tenant.id, id);
      await this.audit.append(tx, {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'ai.provider.deleted',
        targetType: 'ai_provider',
        targetId: id,
        metadata: { name: row.name },
        ip: clientIp(req),
      });
      await this.outbox.enqueue(tx, { tenantId: tenant.id, type: 'ai.provider.deleted', payload: { providerId: id } });
    });
  }

  /** Sets the failover order: the first provider is the primary AI. */
  @Put('providers/order')
  @RequirePermission('ai.manage')
  reorder(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(reorderAiProvidersSchema)) body: ReorderAiProviders,
    @Req() req: Request,
  ): Promise<AiProviderResponse[]> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const list = await this.providers.reorder(tx, tenant.id, body.order);
      await this.audit.append(tx, {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'ai.provider.reordered',
        targetType: 'ai_provider',
        metadata: { order: body.order },
        ip: clientIp(req),
      });
      await this.outbox.enqueue(tx, { tenantId: tenant.id, type: 'ai.provider.reordered', payload: { order: body.order } });
      return list;
    });
  }

  @Get('providers/:id/models')
  @RequirePermission('ai.manage')
  models(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<string[]> {
    return this.providers.models(tenant.id, user.id, id);
  }

  @Post('providers/:id/test')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  test(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<AiProviderTestResult> {
    return this.providers.test(tenant.id, user.id, id);
  }

  /** Token and cost monitor: totals per provider over the last N days. */
  @Get('usage')
  @RequirePermission('ai.manage')
  usage(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(usageQuery)) q: z.infer<typeof usageQuery>,
  ): Promise<AiUsageResponse> {
    const since = new Date(Date.now() - q.days * 86_400_000);
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const rows = await tx
        .select({
          providerId: aiProviderCalls.providerId,
          providerName: aiProviders.name,
          calls: sql<number>`count(*)::int`,
          failures: sql<number>`(count(*) filter (where ${aiProviderCalls.outcome} <> 'ok'))::int`,
          inputTokens: sql<number>`coalesce(sum(${aiProviderCalls.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${aiProviderCalls.outputTokens}), 0)::int`,
          costUsd: sql<string>`coalesce(sum(${aiProviderCalls.costUsd}), 0)`,
        })
        .from(aiProviderCalls)
        .innerJoin(aiProviders, eq(aiProviders.id, aiProviderCalls.providerId))
        .where(and(eq(aiProviderCalls.tenantId, tenant.id), gte(aiProviderCalls.createdAt, since)))
        .groupBy(aiProviderCalls.providerId, aiProviders.name)
        .orderBy(aiProviders.name);
      const out = rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) }));
      return {
        since: since.toISOString(),
        rows: out,
        totalCostUsd: Math.round(out.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6,
      };
    });
  }
}
