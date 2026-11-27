import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import type {
  CreateMemory,
  CreateProject,
  MemoryResponse,
  ProjectResponse,
  UpdateMemory,
  UpdateProject,
} from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import { DbService, type Tx } from '../db/db.service';
import type { Ctx } from './chat.service';

const { aiMemories, aiProjects } = schema;
type ProjectRow = typeof aiProjects.$inferSelect;
type MemoryRow = typeof aiMemories.$inferSelect;

/** Most memory a single prompt carries; pinned notes go first, then the most recently edited. */
export const MEMORY_PROMPT_CHARS = 16_000;

/** Projects and project memory, shared inside the tenant and kept by MARIS rather than by any AI provider. */
@Injectable()
export class MemoryService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  listProjects(ctx: Ctx): Promise<ProjectResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(aiProjects)
        .where(and(eq(aiProjects.tenantId, ctx.tenantId), isNull(aiProjects.deletedAt)))
        .orderBy(desc(aiProjects.updatedAt));
      const counts = await tx
        .select({ projectId: aiMemories.projectId, n: sql<number>`count(*)::int` })
        .from(aiMemories)
        .where(and(eq(aiMemories.tenantId, ctx.tenantId), isNull(aiMemories.deletedAt)))
        .groupBy(aiMemories.projectId);
      const byProject = new Map(counts.map((c) => [c.projectId, Number(c.n)]));
      return rows.map((r) => projectResponse(r, byProject.get(r.id) ?? 0));
    });
  }

  createProject(ctx: Ctx, body: CreateProject): Promise<ProjectResponse> {
    return this.db.withContext(ctx, async (tx) => {
      await this.assertProjectNameFree(tx, ctx.tenantId, body.name);
      const [row] = await tx
        .insert(aiProjects)
        .values({ id: uuidv7(), tenantId: ctx.tenantId, name: body.name, description: body.description ?? null, createdBy: ctx.userId })
        .returning();
      await this.log(tx, ctx, 'ai.project.created', 'ai_project', row!.id, { name: row!.name });
      return projectResponse(row!, 0);
    });
  }

  updateProject(ctx: Ctx, id: string, body: UpdateProject): Promise<ProjectResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.project(tx, ctx.tenantId, id);
      if (body.name && body.name.toLowerCase() !== current.name.toLowerCase()) await this.assertProjectNameFree(tx, ctx.tenantId, body.name);
      const [row] = await tx
        .update(aiProjects)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(aiProjects.id, id))
        .returning();
      await this.log(tx, ctx, 'ai.project.updated', 'ai_project', id, { fields: Object.keys(body) });
      return projectResponse(row!, await this.count(tx, id));
    });
  }

  removeProject(ctx: Ctx, id: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      await this.project(tx, ctx.tenantId, id);
      const now = new Date();
      await tx.update(aiMemories).set({ deletedAt: now, updatedAt: now }).where(and(eq(aiMemories.projectId, id), isNull(aiMemories.deletedAt)));
      await tx.update(aiProjects).set({ deletedAt: now, updatedAt: now }).where(eq(aiProjects.id, id));
      await this.log(tx, ctx, 'ai.project.deleted', 'ai_project', id);
    });
  }

  listMemories(ctx: Ctx, projectId: string): Promise<MemoryResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.project(tx, ctx.tenantId, projectId);
      return (await this.memories(tx, projectId)).map(memoryResponse);
    });
  }

  createMemory(ctx: Ctx, projectId: string, body: CreateMemory): Promise<MemoryResponse> {
    return this.db.withContext(ctx, async (tx) => {
      await this.project(tx, ctx.tenantId, projectId);
      const [row] = await tx
        .insert(aiMemories)
        .values({
          id: uuidv7(),
          tenantId: ctx.tenantId,
          projectId,
          title: body.title,
          content: body.content,
          pinned: body.pinned ?? false,
          createdBy: ctx.userId,
        })
        .returning();
      await this.touch(tx, projectId);
      // Memory text stays out of the audit log.
      await this.log(tx, ctx, 'ai.memory.created', 'ai_memory', row!.id, { projectId, chars: body.content.length });
      return memoryResponse(row!);
    });
  }

  updateMemory(ctx: Ctx, id: string, body: UpdateMemory): Promise<MemoryResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.memory(tx, ctx.tenantId, id);
      const [row] = await tx
        .update(aiMemories)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(aiMemories.id, id))
        .returning();
      await this.touch(tx, current.projectId);
      await this.log(tx, ctx, 'ai.memory.updated', 'ai_memory', id, { projectId: current.projectId, fields: Object.keys(body) });
      return memoryResponse(row!);
    });
  }

  removeMemory(ctx: Ctx, id: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.memory(tx, ctx.tenantId, id);
      await tx.update(aiMemories).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(aiMemories.id, id));
      await this.touch(tx, current.projectId);
      await this.log(tx, ctx, 'ai.memory.deleted', 'ai_memory', id, { projectId: current.projectId });
    });
  }

  async project(tx: Tx, tenantId: string, id: string): Promise<ProjectRow> {
    const [row] = await tx
      .select()
      .from(aiProjects)
      .where(and(eq(aiProjects.id, id), eq(aiProjects.tenantId, tenantId), isNull(aiProjects.deletedAt)));
    if (!row) throw new NotFoundException({ code: 'AI_PROJECT_NOT_FOUND', message: 'Không tìm thấy dự án' });
    return row;
  }

  /** The project's memory as prompt text, within MEMORY_PROMPT_CHARS. */
  async promptBlock(tx: Tx, project: ProjectRow): Promise<string> {
    const rows = await this.memories(tx, project.id);
    const lines = [`Dự án: ${project.name}${project.description ? ` (${project.description})` : ''}`];
    let used = lines[0]!.length;
    for (const m of rows) {
      const line = `- ${m.title}: ${m.content}`;
      if (used + line.length > MEMORY_PROMPT_CHARS) break;
      lines.push(line);
      used += line.length;
    }
    return lines.join('\n');
  }

  private memories(tx: Tx, projectId: string): Promise<MemoryRow[]> {
    return tx
      .select()
      .from(aiMemories)
      .where(and(eq(aiMemories.projectId, projectId), isNull(aiMemories.deletedAt)))
      .orderBy(desc(aiMemories.pinned), desc(aiMemories.updatedAt));
  }

  private async memory(tx: Tx, tenantId: string, id: string): Promise<MemoryRow> {
    const [row] = await tx
      .select()
      .from(aiMemories)
      .where(and(eq(aiMemories.id, id), eq(aiMemories.tenantId, tenantId), isNull(aiMemories.deletedAt)));
    if (!row) throw new NotFoundException({ code: 'AI_MEMORY_NOT_FOUND', message: 'Không tìm thấy mục bộ nhớ' });
    return row;
  }

  private async count(tx: Tx, projectId: string): Promise<number> {
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(aiMemories)
      .where(and(eq(aiMemories.projectId, projectId), isNull(aiMemories.deletedAt)));
    return Number(r?.n ?? 0);
  }

  private async touch(tx: Tx, projectId: string): Promise<void> {
    await tx.update(aiProjects).set({ updatedAt: new Date() }).where(eq(aiProjects.id, projectId));
  }

  private async assertProjectNameFree(tx: Tx, tenantId: string, name: string): Promise<void> {
    const [dup] = await tx
      .select({ id: aiProjects.id })
      .from(aiProjects)
      .where(and(eq(aiProjects.tenantId, tenantId), isNull(aiProjects.deletedAt), sql`lower(${aiProjects.name}) = lower(${name})`));
    if (dup) throw new ConflictException({ code: 'AI_PROJECT_EXISTS', message: `Đã có dự án tên "${name}"` });
  }

  private log(tx: Tx, ctx: Ctx, action: string, targetType: string, targetId: string, metadata?: Record<string, unknown>) {
    return this.audit.append(tx, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action, targetType, targetId, metadata, ip: ctx.ip });
  }
}

function projectResponse(r: ProjectRow, memoryCount: number): ProjectResponse {
  return { id: r.id, name: r.name, description: r.description, memoryCount, updatedAt: r.updatedAt.toISOString() };
}

function memoryResponse(r: MemoryRow): MemoryResponse {
  return { id: r.id, projectId: r.projectId, title: r.title, content: r.content, pinned: r.pinned, updatedAt: r.updatedAt.toISOString() };
}
