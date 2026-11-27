import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import type { CreateModel, ModelCapability, ModelResponse, UpdateModel } from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import type { Tx } from '../db/db.service';
import type { Candidate } from './ai-router.service';
import { AiProvidersService } from './ai-providers.service';
import type { Ctx } from './chat.service';

const { aiModels } = schema;
export type ModelRow = typeof aiModels.$inferSelect;

/**
 * Model Registry and Capability Registry: per tenant, the models each provider offers, what they
 * are good at and what they cost. Stored by MARIS, so it survives switching providers.
 */
@Injectable()
export class ModelsService {
  constructor(
    private readonly providers: AiProvidersService,
    private readonly audit: AuditService,
  ) {}

  rows(tx: Tx, tenantId: string): Promise<ModelRow[]> {
    return tx
      .select()
      .from(aiModels)
      .where(eq(aiModels.tenantId, tenantId))
      .orderBy(asc(aiModels.providerId), asc(aiModels.model));
  }

  async list(tx: Tx, tenantId: string): Promise<ModelResponse[]> {
    return (await this.rows(tx, tenantId)).map(modelResponse);
  }

  async create(tx: Tx, ctx: Ctx, body: CreateModel): Promise<ModelResponse> {
    await this.providers.get(tx, ctx.tenantId, body.providerId);
    const [taken] = await tx
      .select({ id: aiModels.id })
      .from(aiModels)
      .where(
        and(
          eq(aiModels.tenantId, ctx.tenantId),
          eq(aiModels.providerId, body.providerId),
          eq(aiModels.model, body.model),
        ),
      );
    if (taken)
      throw new ConflictException({
        code: 'AI_MODEL_EXISTS',
        message: `Model ${body.model} đã có trong danh mục của AI này`,
      });
    const [row] = await tx
      .insert(aiModels)
      .values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        providerId: body.providerId,
        model: body.model,
        capabilities: body.capabilities,
        contextWindow: body.contextWindow ?? null,
        inputCostPerMtok: numOrNull(body.inputCostPerMtok),
        outputCostPerMtok: numOrNull(body.outputCostPerMtok),
        enabled: body.enabled ?? true,
        createdBy: ctx.userId,
      })
      .returning();
    await this.log(tx, ctx, 'ai.model.created', row!, {
      providerId: body.providerId,
      model: body.model,
      capabilities: body.capabilities,
    });
    return modelResponse(row!);
  }

  async update(tx: Tx, ctx: Ctx, id: string, body: UpdateModel): Promise<ModelResponse> {
    await this.get(tx, ctx.tenantId, id);
    const [row] = await tx
      .update(aiModels)
      .set({
        ...(body.capabilities !== undefined ? { capabilities: body.capabilities } : {}),
        ...(body.contextWindow !== undefined ? { contextWindow: body.contextWindow } : {}),
        ...(body.inputCostPerMtok !== undefined
          ? { inputCostPerMtok: numOrNull(body.inputCostPerMtok) }
          : {}),
        ...(body.outputCostPerMtok !== undefined
          ? { outputCostPerMtok: numOrNull(body.outputCostPerMtok) }
          : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiModels.id, id))
      .returning();
    await this.log(tx, ctx, 'ai.model.updated', row!, { fields: Object.keys(body) });
    return modelResponse(row!);
  }

  async remove(tx: Tx, ctx: Ctx, id: string): Promise<void> {
    const row = await this.get(tx, ctx.tenantId, id);
    await tx.delete(aiModels).where(eq(aiModels.id, id));
    await this.log(tx, ctx, 'ai.model.removed', row, {
      providerId: row.providerId,
      model: row.model,
    });
  }

  private async get(tx: Tx, tenantId: string, id: string): Promise<ModelRow> {
    const [row] = await tx
      .select()
      .from(aiModels)
      .where(and(eq(aiModels.id, id), eq(aiModels.tenantId, tenantId)));
    if (!row)
      throw new NotFoundException({ code: 'AI_MODEL_NOT_FOUND', message: 'Không tìm thấy model' });
    return row;
  }

  private log(tx: Tx, ctx: Ctx, action: string, row: ModelRow, metadata: Record<string, unknown>) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'ai_model',
      targetId: row.id,
      metadata,
      ip: ctx.ip,
    });
  }
}

/**
 * Applies the registry to the router's candidates:
 * - a candidate whose model was not named by the user or agent switches to the provider's enabled
 *   model with the capability the chat mode prefers, when there is one;
 * - a disabled model is dropped;
 * - model prices replace the provider's prices.
 */
export function applyRegistry(
  candidates: Candidate[],
  models: ModelRow[],
  capability: ModelCapability | undefined,
): Candidate[] {
  const out: Candidate[] = [];
  for (const c of candidates) {
    let model = c.model;
    let entry = models.find((m) => m.providerId === c.provider.id && m.model === model);
    if (!c.pinned && capability && !(entry?.enabled && entry.capabilities.includes(capability))) {
      const better = models.find(
        (m) => m.providerId === c.provider.id && m.enabled && m.capabilities.includes(capability),
      );
      if (better) {
        model = better.model;
        entry = better;
      }
    }
    if (entry && !entry.enabled) continue;
    const priced = entry && (entry.inputCostPerMtok != null || entry.outputCostPerMtok != null);
    out.push({
      ...c,
      model,
      ...(priced
        ? {
            price: {
              inputCostPerMtok: entry!.inputCostPerMtok,
              outputCostPerMtok: entry!.outputCostPerMtok,
            },
          }
        : {}),
    });
  }
  return out;
}

function numOrNull(v: number | null | undefined): string | null {
  return v == null ? null : String(v);
}

export function modelResponse(r: ModelRow): ModelResponse {
  return {
    id: r.id,
    providerId: r.providerId,
    model: r.model,
    capabilities: r.capabilities as ModelCapability[],
    contextWindow: r.contextWindow,
    inputCostPerMtok: r.inputCostPerMtok == null ? null : Number(r.inputCostPerMtok),
    outputCostPerMtok: r.outputCostPerMtok == null ? null : Number(r.outputCostPerMtok),
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
