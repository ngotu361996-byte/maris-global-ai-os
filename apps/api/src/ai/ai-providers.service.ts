import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  AI_PROVIDER_PRESETS,
  type AiProviderResponse,
  type AiProviderTestResult,
  type CreateAiProvider,
  type UpdateAiProvider,
} from '@maris/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { SecretVaultService } from '../secrets/secret-vault.service';
import { adapterFor, baseUrlFor } from './adapters';
import type { ProviderRow } from './ai-router.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { ProviderError, toProviderError } from './provider-error';
import { assertAllowedProviderUrl } from './url-guard';

const { aiProviders, secrets } = schema;

@Injectable()
export class AiProvidersService {
  constructor(
    private readonly db: DbService,
    private readonly vault: SecretVaultService,
    private readonly breaker: CircuitBreakerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Live providers in failover order (primary first). */
  async rows(tx: Tx, tenantId: string): Promise<ProviderRow[]> {
    return tx
      .select()
      .from(aiProviders)
      .where(and(eq(aiProviders.tenantId, tenantId), isNull(aiProviders.deletedAt)))
      .orderBy(asc(aiProviders.priority), asc(aiProviders.createdAt));
  }

  async get(tx: Tx, tenantId: string, id: string): Promise<ProviderRow> {
    const [row] = await tx
      .select()
      .from(aiProviders)
      .where(and(eq(aiProviders.id, id), eq(aiProviders.tenantId, tenantId), isNull(aiProviders.deletedAt)));
    if (!row) throw new NotFoundException({ code: 'AI_PROVIDER_NOT_FOUND', message: 'Không tìm thấy AI Provider' });
    return row;
  }

  async list(tx: Tx, tenantId: string): Promise<AiProviderResponse[]> {
    const rows = await this.rows(tx, tenantId);
    const open = await this.breaker.openStates(rows.map((r) => r.id));
    return rows.map((r) => toResponse(r, open.has(r.id)));
  }

  async create(tx: Tx, tenantId: string, userId: string, body: CreateAiProvider): Promise<AiProviderResponse> {
    const baseUrl = body.baseUrl ?? null;
    const secretRef = body.secretRef ?? null;
    await this.validate(tx, tenantId, body.kind, baseUrl, secretRef);
    await this.assertNameFree(tx, tenantId, body.name);
    const [{ next }] = (await tx
      .select({ next: sql<number>`coalesce(max(${aiProviders.priority}), 0) + 10` })
      .from(aiProviders)
      .where(and(eq(aiProviders.tenantId, tenantId), isNull(aiProviders.deletedAt)))) as [{ next: number }];
    const [row] = await tx
      .insert(aiProviders)
      .values({
        id: uuidv7(),
        tenantId,
        name: body.name,
        kind: body.kind,
        baseUrl,
        secretRef,
        defaultModel: body.defaultModel,
        priority: Number(next),
        enabled: body.enabled ?? true,
        timeoutMs: body.timeoutMs ?? 60_000,
        inputCostPerMtok: numOrNull(body.inputCostPerMtok),
        outputCostPerMtok: numOrNull(body.outputCostPerMtok),
        createdBy: userId,
      })
      .returning();
    return toResponse(row!, false);
  }

  async update(tx: Tx, tenantId: string, id: string, body: UpdateAiProvider): Promise<AiProviderResponse> {
    const current = await this.get(tx, tenantId, id);
    const baseUrl = body.baseUrl !== undefined ? body.baseUrl : current.baseUrl;
    const secretRef = body.secretRef !== undefined ? body.secretRef : current.secretRef;
    await this.validate(tx, tenantId, current.kind, baseUrl, secretRef);
    if (body.name && body.name.toLowerCase() !== current.name.toLowerCase()) await this.assertNameFree(tx, tenantId, body.name);
    const [row] = await tx
      .update(aiProviders)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        baseUrl,
        secretRef,
        ...(body.defaultModel !== undefined ? { defaultModel: body.defaultModel } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
        ...(body.inputCostPerMtok !== undefined ? { inputCostPerMtok: numOrNull(body.inputCostPerMtok) } : {}),
        ...(body.outputCostPerMtok !== undefined ? { outputCostPerMtok: numOrNull(body.outputCostPerMtok) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiProviders.id, id))
      .returning();
    // A changed key or address deserves a fresh chance.
    if (body.secretRef !== undefined || body.baseUrl !== undefined || body.enabled) await this.breaker.reset(id);
    const open = await this.breaker.isOpen(id);
    return toResponse(row!, open);
  }

  async remove(tx: Tx, tenantId: string, id: string): Promise<ProviderRow> {
    const row = await this.get(tx, tenantId, id);
    await tx.update(aiProviders).set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() }).where(eq(aiProviders.id, id));
    return row;
  }

  async reorder(tx: Tx, tenantId: string, order: string[]): Promise<AiProviderResponse[]> {
    const rows = await this.rows(tx, tenantId);
    const ids = new Set(rows.map((r) => r.id));
    if (order.length !== ids.size || new Set(order).size !== order.length || order.some((id) => !ids.has(id))) {
      throw new BadRequestException({ code: 'AI_ORDER_MISMATCH', message: 'Danh sách thứ tự phải gồm đúng mọi AI Provider hiện có' });
    }
    for (const [i, id] of order.entries()) {
      await tx.update(aiProviders).set({ priority: (i + 1) * 10, updatedAt: new Date() }).where(eq(aiProviders.id, id));
    }
    return this.list(tx, tenantId);
  }

  /** Lists the provider's models using its own API, so the UI can offer real model names. */
  async models(tenantId: string, userId: string, id: string): Promise<string[]> {
    const { provider, apiKey } = await this.target(tenantId, userId, id);
    const baseUrl = baseUrlFor(provider.kind, provider.baseUrl);
    try {
      const models = await adapterFor(provider.kind).listModels(
        { kind: provider.kind, baseUrl, apiKey },
        AbortSignal.timeout(Math.min(provider.timeoutMs, 20_000)),
      );
      return [...new Set(models)].sort();
    } catch (err) {
      const e = toProviderError(err);
      throw new BadRequestException({ code: `AI_${e.code}`, message: `Không lấy được danh sách model: ${e.message}` });
    }
  }

  /** Sends a tiny prompt and stops at the first piece of text. */
  async test(tenantId: string, userId: string, id: string): Promise<AiProviderTestResult> {
    const { provider, apiKey } = await this.target(tenantId, userId, id);
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(provider.timeoutMs, 30_000));
    let got = false;
    try {
      await adapterFor(provider.kind).stream(
        { kind: provider.kind, baseUrl: baseUrlFor(provider.kind, provider.baseUrl), apiKey, model: provider.defaultModel },
        [{ role: 'user', content: 'Reply with the single word OK.' }],
        () => {
          got = true;
          ctrl.abort();
        },
        ctrl.signal,
      );
      got = true;
    } catch (err) {
      if (!got) {
        const e = ctrl.signal.aborted ? new ProviderError('TIMEOUT', 'Quá thời gian chờ') : toProviderError(err);
        return { ok: false, latencyMs: Date.now() - started, model: provider.defaultModel, errorCode: e.code, message: e.message };
      }
    } finally {
      clearTimeout(timer);
    }
    await this.breaker.reset(provider.id);
    return { ok: true, latencyMs: Date.now() - started, model: provider.defaultModel };
  }

  /** Resolves a provider and its key, checking the URL first. The key stays server-side. */
  private async target(tenantId: string, userId: string, id: string): Promise<{ provider: ProviderRow; apiKey: string | null }> {
    return this.db.withContext({ userId, tenantId }, async (tx) => {
      const provider = await this.get(tx, tenantId, id);
      try {
        await assertAllowedProviderUrl(baseUrlFor(provider.kind, provider.baseUrl), {
          kind: provider.kind,
          allowPrivate: this.config.AI_ALLOW_PRIVATE_URLS,
        });
      } catch (err) {
        const e = toProviderError(err);
        throw new BadRequestException({ code: `AI_${e.code}`, message: e.message });
      }
      const apiKey = provider.secretRef ? await this.vault.resolve(tx, tenantId, provider.secretRef) : null;
      return { provider, apiKey };
    });
  }

  private async validate(tx: Tx, tenantId: string, kind: ProviderRow['kind'], baseUrl: string | null, secretRef: string | null) {
    const preset = AI_PROVIDER_PRESETS[kind];
    if (!baseUrl && !preset.defaultBaseUrl) {
      throw new BadRequestException({ code: 'AI_BASE_URL_REQUIRED', message: 'Loại AI này cần nhập địa chỉ API (base URL)' });
    }
    if (preset.needsKey && !secretRef) {
      throw new BadRequestException({ code: 'AI_SECRET_REQUIRED', message: 'Chọn API key trong Secret Vault cho AI này' });
    }
    if (baseUrl) {
      try {
        await assertAllowedProviderUrl(baseUrl, { kind, allowPrivate: this.config.AI_ALLOW_PRIVATE_URLS });
      } catch (err) {
        const e = toProviderError(err);
        throw new BadRequestException({ code: `AI_${e.code}`, message: e.message });
      }
    }
    if (secretRef) {
      const [found] = await tx
        .select({ id: secrets.id })
        .from(secrets)
        .where(and(eq(secrets.id, secretRef.slice('secret://'.length)), eq(secrets.tenantId, tenantId), isNull(secrets.deletedAt)));
      if (!found) throw new BadRequestException({ code: 'SECRET_NOT_FOUND', message: 'Không tìm thấy key này trong Secret Vault' });
    }
  }

  private async assertNameFree(tx: Tx, tenantId: string, name: string) {
    const [dup] = await tx
      .select({ id: aiProviders.id })
      .from(aiProviders)
      .where(and(eq(aiProviders.tenantId, tenantId), isNull(aiProviders.deletedAt), sql`lower(${aiProviders.name}) = lower(${name})`));
    if (dup) throw new ConflictException({ code: 'AI_PROVIDER_EXISTS', message: `Đã có AI Provider tên "${name}"` });
  }
}

function numOrNull(v: number | null | undefined): string | null {
  return v == null ? null : String(v);
}

export function toResponse(r: ProviderRow, open: boolean): AiProviderResponse {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    baseUrl: r.baseUrl,
    secretRef: r.secretRef,
    defaultModel: r.defaultModel,
    priority: r.priority,
    enabled: r.enabled,
    timeoutMs: r.timeoutMs,
    inputCostPerMtok: r.inputCostPerMtok == null ? null : Number(r.inputCostPerMtok),
    outputCostPerMtok: r.outputCostPerMtok == null ? null : Number(r.outputCostPerMtok),
    health: open ? 'open' : 'ok',
  };
}
