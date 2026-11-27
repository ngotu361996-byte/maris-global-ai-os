import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  AGENT_TEMPLATES,
  templatePrompt,
  type AgentResponse,
  type AgentVersionResponse,
  type CreateAgent,
  type UpdateAgent,
} from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import { DbService, type Tx } from '../db/db.service';
import { AiProvidersService } from './ai-providers.service';
import type { Ctx } from './chat.service';

const { aiAgents, aiAgentVersions } = schema;
export type AgentRow = typeof aiAgents.$inferSelect;

/**
 * AI Agents are configuration: a role, a prompt and an optional provider/model. Every change
 * bumps the version and keeps a snapshot, so an agent can be compared with what it was before.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly db: DbService,
    private readonly providers: AiProvidersService,
    private readonly audit: AuditService,
  ) {}

  list(ctx: Ctx): Promise<AgentResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(aiAgents)
        .where(and(eq(aiAgents.tenantId, ctx.tenantId), isNull(aiAgents.deletedAt)))
        .orderBy(asc(aiAgents.createdAt));
      return rows.map(agentResponse);
    });
  }

  versions(ctx: Ctx, id: string): Promise<AgentVersionResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.get(tx, ctx.tenantId, id);
      const rows = await tx.select().from(aiAgentVersions).where(eq(aiAgentVersions.agentId, id)).orderBy(desc(aiAgentVersions.version));
      return rows.map((r) => ({ version: r.version, config: r.config, createdAt: r.createdAt.toISOString() }));
    });
  }

  create(ctx: Ctx, body: CreateAgent): Promise<AgentResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const row = await this.insert(tx, ctx, {
        key: body.key,
        name: body.name,
        role: body.role,
        systemPrompt: body.systemPrompt,
        evalCriteria: body.evalCriteria ?? null,
        providerId: body.providerId ?? null,
        model: body.model ?? null,
        status: body.status ?? 'active',
        accessLevel: body.accessLevel ?? 'prepare',
        templateKey: null,
      });
      return agentResponse(row);
    });
  }

  /** Installs the spec's starter agents. Keys already in use are skipped, so it is safe to run twice. */
  installTemplates(ctx: Ctx, keys: string[]): Promise<AgentResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const unknown = keys.filter((k) => !AGENT_TEMPLATES.some((t) => t.key === k));
      if (unknown.length) throw new BadRequestException({ code: 'AGENT_TEMPLATE_UNKNOWN', message: `Không có mẫu: ${unknown.join(', ')}` });
      const wanted = keys.length ? AGENT_TEMPLATES.filter((t) => keys.includes(t.key)) : AGENT_TEMPLATES;
      const existing = await tx
        .select({ key: aiAgents.key })
        .from(aiAgents)
        .where(and(eq(aiAgents.tenantId, ctx.tenantId), isNull(aiAgents.deletedAt)));
      const taken = new Set(existing.map((r) => r.key));
      const created: AgentRow[] = [];
      for (const t of wanted) {
        if (taken.has(t.key)) continue;
        created.push(
          await this.insert(
            tx,
            ctx,
            {
              key: t.key,
              name: t.name,
              role: t.role,
              systemPrompt: templatePrompt(t),
              evalCriteria: null,
              providerId: null,
              model: null,
              status: 'active',
              accessLevel: 'prepare',
              templateKey: t.key,
            },
            false,
          ),
        );
      }
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ai.agent.templates_installed',
        targetType: 'ai_agent',
        metadata: { keys: created.map((r) => r.key) },
        ip: ctx.ip,
      });
      return created.map(agentResponse);
    });
  }

  update(ctx: Ctx, id: string, body: UpdateAgent): Promise<AgentResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.get(tx, ctx.tenantId, id);
      if (body.providerId) await this.providers.get(tx, ctx.tenantId, body.providerId);
      const version = current.version + 1;
      const [row] = await tx
        .update(aiAgents)
        .set({ ...body, version, updatedAt: new Date() })
        .where(eq(aiAgents.id, id))
        .returning();
      await this.snapshot(tx, ctx, row!);
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ai.agent.updated',
        targetType: 'ai_agent',
        targetId: id,
        metadata: { fields: Object.keys(body), version },
        ip: ctx.ip,
      });
      // Access level changes get their own entry: they decide what the agent may do.
      if (body.accessLevel && body.accessLevel !== current.accessLevel) {
        await this.audit.append(tx, {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: 'ai.agent.access_level_changed',
          targetType: 'ai_agent',
          targetId: id,
          metadata: { from: current.accessLevel, to: body.accessLevel },
          ip: ctx.ip,
        });
      }
      return agentResponse(row!);
    });
  }

  remove(ctx: Ctx, id: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      const row = await this.get(tx, ctx.tenantId, id);
      await tx.update(aiAgents).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(aiAgents.id, id));
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ai.agent.deleted',
        targetType: 'ai_agent',
        targetId: id,
        metadata: { key: row.key },
        ip: ctx.ip,
      });
    });
  }

  async get(tx: Tx, tenantId: string, id: string): Promise<AgentRow> {
    const [row] = await tx
      .select()
      .from(aiAgents)
      .where(and(eq(aiAgents.id, id), eq(aiAgents.tenantId, tenantId), isNull(aiAgents.deletedAt)));
    if (!row) throw new NotFoundException({ code: 'AI_AGENT_NOT_FOUND', message: 'Không tìm thấy AI Agent' });
    return row;
  }

  private async insert(
    tx: Tx,
    ctx: Ctx,
    v: Omit<AgentRow, 'id' | 'tenantId' | 'version' | 'createdBy' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
    audit = true,
  ): Promise<AgentRow> {
    if (v.providerId) await this.providers.get(tx, ctx.tenantId, v.providerId);
    const [dup] = await tx
      .select({ id: aiAgents.id })
      .from(aiAgents)
      .where(and(eq(aiAgents.tenantId, ctx.tenantId), eq(aiAgents.key, v.key), isNull(aiAgents.deletedAt)));
    if (dup) throw new ConflictException({ code: 'AI_AGENT_EXISTS', message: `Đã có AI Agent mã "${v.key}"` });
    const [row] = await tx
      .insert(aiAgents)
      .values({ ...v, id: uuidv7(), tenantId: ctx.tenantId, version: 1, createdBy: ctx.userId })
      .returning();
    await this.snapshot(tx, ctx, row!);
    if (audit) {
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ai.agent.created',
        targetType: 'ai_agent',
        targetId: row!.id,
        metadata: { key: row!.key },
        ip: ctx.ip,
      });
    }
    return row!;
  }

  private async snapshot(tx: Tx, ctx: Ctx, row: AgentRow): Promise<void> {
    await tx.insert(aiAgentVersions).values({
      id: uuidv7(),
      tenantId: ctx.tenantId,
      agentId: row.id,
      version: row.version,
      config: {
        name: row.name,
        role: row.role,
        systemPrompt: row.systemPrompt,
        evalCriteria: row.evalCriteria,
        providerId: row.providerId,
        model: row.model,
        status: row.status,
        accessLevel: row.accessLevel,
      },
      createdBy: ctx.userId,
    });
  }
}

export function agentResponse(r: AgentRow): AgentResponse {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    role: r.role,
    systemPrompt: r.systemPrompt,
    evalCriteria: r.evalCriteria,
    providerId: r.providerId,
    model: r.model,
    status: r.status,
    templateKey: r.templateKey,
    accessLevel: r.accessLevel,
    version: r.version,
    updatedAt: r.updatedAt.toISOString(),
  };
}
