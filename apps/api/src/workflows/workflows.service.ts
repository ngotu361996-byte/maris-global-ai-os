import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  WORKFLOW_FORMAT,
  WORKFLOW_TEMPLATES,
  workflowManifestSchema,
  type CopyWorkflow,
  type CreateWorkflow,
  type ImportWorkflow,
  type UpdateWorkflow,
  type WorkflowGraph,
  type WorkflowManifest,
  type WorkflowResponse,
  type WorkflowVersionResponse,
} from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import { DbService, type Tx } from '../db/db.service';
import type { Ctx } from '../ai/chat.service';
import { graphChecksum } from './workflow-engine';

const { workflowDefinitions, workflowVersions, aiSkills, aiAgents, connectors } = schema;
export type WorkflowRow = typeof workflowDefinitions.$inferSelect;
type VersionRow = typeof workflowVersions.$inferSelect;

/**
 * Workflow Studio definitions (spec Part 22). Each save of the steps is a new version that never
 * changes; a run keeps the version it started with. Skills and agents are referred to by key, so an
 * exported file works in another workspace that has the same skills and agents.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  list(ctx: Ctx): Promise<WorkflowResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(workflowDefinitions)
        .where(
          and(
            eq(workflowDefinitions.tenantId, ctx.tenantId),
            isNull(workflowDefinitions.deletedAt),
          ),
        )
        .orderBy(asc(workflowDefinitions.name));
      const out: WorkflowResponse[] = [];
      for (const r of rows) out.push(response(r, await this.version(tx, r.id, r.version)));
      return out;
    });
  }

  get(ctx: Ctx, id: string): Promise<WorkflowResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const r = await this.row(tx, ctx.tenantId, id);
      return response(r, await this.version(tx, r.id, r.version));
    });
  }

  versions(ctx: Ctx, id: string): Promise<WorkflowVersionResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.row(tx, ctx.tenantId, id);
      const rows = await tx
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.workflowId, id))
        .orderBy(desc(workflowVersions.version));
      return rows.map((v) => ({
        version: v.version,
        checksum: v.checksum,
        note: v.note,
        nodes: v.graph.nodes.length,
        createdAt: v.createdAt.toISOString(),
      }));
    });
  }

  create(ctx: Ctx, body: CreateWorkflow & { graph: WorkflowGraph }): Promise<WorkflowResponse> {
    return this.db.withContext(ctx, async (tx) => {
      await this.assertKeyFree(tx, ctx.tenantId, body.key);
      await this.assertReferences(tx, ctx.tenantId, body.graph);
      const { row, version } = await this.insert(
        tx,
        ctx,
        {
          key: body.key,
          name: body.name,
          description: body.description ?? '',
          source: 'created',
          status: 'active',
        },
        body.graph,
        null,
      );
      await this.log(tx, ctx, 'workflow.created', row.id, { key: row.key, version: 1 });
      return response(row, version);
    });
  }

  /** Installs the starter workflows whose skills are installed. Keys already used are skipped. */
  installTemplates(ctx: Ctx): Promise<{ created: WorkflowResponse[]; missingSkills: string[] }> {
    return this.db.withContext(ctx, async (tx) => {
      const taken = new Set(
        (
          await tx
            .select({ key: workflowDefinitions.key })
            .from(workflowDefinitions)
            .where(
              and(
                eq(workflowDefinitions.tenantId, ctx.tenantId),
                isNull(workflowDefinitions.deletedAt),
              ),
            )
        ).map((r) => r.key),
      );
      const skills = new Set((await this.activeSkills(tx, ctx.tenantId)).map((s) => s.key));
      const created: WorkflowResponse[] = [];
      const missing = new Set<string>();
      for (const t of WORKFLOW_TEMPLATES) {
        if (taken.has(t.key)) continue;
        const lacking = t.skills.filter((k) => !skills.has(k));
        if (lacking.length) {
          lacking.forEach((k) => missing.add(k));
          continue;
        }
        const graph = workflowManifestSchema.shape.graph.parse(t.graph);
        const { row, version } = await this.insert(
          tx,
          ctx,
          {
            key: t.key,
            name: t.name,
            description: t.description,
            source: 'template',
            status: 'active',
          },
          graph,
          null,
        );
        await this.log(tx, ctx, 'workflow.created', row.id, {
          key: row.key,
          version: 1,
          template: true,
        });
        created.push(response(row, version));
      }
      return { created, missingSkills: [...missing] };
    });
  }

  /** A new graph saves a new version; name, description and status change the definition only. */
  update(
    ctx: Ctx,
    id: string,
    body: UpdateWorkflow & { graph?: WorkflowGraph },
  ): Promise<WorkflowResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      let version = await this.version(tx, id, current.version);
      let nextVersion = current.version;
      if (body.graph) {
        const checksum = graphChecksum(body.graph);
        if (checksum !== version.checksum) {
          await this.assertReferences(tx, ctx.tenantId, body.graph);
          nextVersion = current.version + 1;
          version = await this.insertVersion(
            tx,
            ctx,
            id,
            nextVersion,
            body.graph,
            body.note ?? null,
          );
        }
      }
      const [row] = await tx
        .update(workflowDefinitions)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          version: nextVersion,
          updatedAt: new Date(),
        })
        .where(eq(workflowDefinitions.id, id))
        .returning();
      const action =
        body.status && body.status !== current.status
          ? body.status === 'active'
            ? 'workflow.activated'
            : 'workflow.paused'
          : 'workflow.updated';
      await this.log(tx, ctx, action, id, { from: current.version, to: nextVersion });
      return response(row!, version);
    });
  }

  /** Saves an older version's steps as the newest version. */
  restoreVersion(ctx: Ctx, id: string, versionNo: number): Promise<WorkflowResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      const old = await this.version(tx, id, versionNo);
      await this.assertReferences(tx, ctx.tenantId, old.graph as WorkflowGraph);
      const v = await this.insertVersion(
        tx,
        ctx,
        id,
        current.version + 1,
        old.graph as WorkflowGraph,
        `Khôi phục từ phiên bản ${versionNo}`,
      );
      const [row] = await tx
        .update(workflowDefinitions)
        .set({ version: v.version, updatedAt: new Date() })
        .where(eq(workflowDefinitions.id, id))
        .returning();
      await this.log(tx, ctx, 'workflow.version_restored', id, { from: versionNo, to: v.version });
      return response(row!, v);
    });
  }

  copy(ctx: Ctx, id: string, body: CopyWorkflow): Promise<WorkflowResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const src = await this.row(tx, ctx.tenantId, id);
      const v = await this.version(tx, id, src.version);
      await this.assertKeyFree(tx, ctx.tenantId, body.key);
      const { row, version } = await this.insert(
        tx,
        ctx,
        {
          key: body.key,
          name: body.name,
          description: src.description,
          source: 'copied',
          status: 'active',
        },
        v.graph as WorkflowGraph,
        `Sao chép từ ${src.key} phiên bản ${src.version}`,
      );
      await this.log(tx, ctx, 'workflow.copied', row.id, {
        from: src.id,
        fromVersion: src.version,
      });
      return response(row, version);
    });
  }

  remove(ctx: Ctx, id: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      const row = await this.row(tx, ctx.tenantId, id);
      await tx
        .update(workflowDefinitions)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(workflowDefinitions.id, id));
      await this.log(tx, ctx, 'workflow.deleted', id, { key: row.key });
    });
  }

  export(ctx: Ctx, id: string): Promise<WorkflowManifest> {
    return this.db.withContext(ctx, async (tx) => {
      const r = await this.row(tx, ctx.tenantId, id);
      const v = await this.version(tx, id, r.version);
      return {
        format: WORKFLOW_FORMAT,
        key: r.key,
        name: r.name,
        description: r.description,
        version: r.version,
        graph: v.graph as WorkflowGraph,
        checksum: v.checksum,
      };
    });
  }

  /**
   * Checks a workflow file: format and steps, the checksum when present, and that every skill and
   * agent it names exists here. An imported workflow arrives paused so someone reads it first.
   */
  import(ctx: Ctx, body: ImportWorkflow): Promise<WorkflowResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const { row, version } = await this.importIn(tx, ctx, body.manifest, body.replace ?? false);
      return response(row, version);
    });
  }

  /** The import inside a caller's transaction; plugins install their workflows with it. */
  async importIn(
    tx: Tx,
    ctx: Ctx,
    manifest: unknown,
    replace: boolean,
  ): Promise<{ row: WorkflowRow; version: VersionRow }> {
    const parsed = workflowManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      throw new BadRequestException({
        code: 'WORKFLOW_INVALID',
        message: `Tệp Workflow không hợp lệ: ${issue.path.join('.') || 'tệp'} – ${issue.message}`,
      });
    }
    const m = parsed.data;
    const checksum = graphChecksum(m.graph);
    if (m.checksum && m.checksum !== checksum) {
      throw new BadRequestException({
        code: 'WORKFLOW_CHECKSUM_MISMATCH',
        message: 'Tệp Workflow đã bị sửa sau khi xuất (checksum không khớp)',
      });
    }
    {
      await this.assertReferences(tx, ctx.tenantId, m.graph);
      const [existing] = await tx
        .select()
        .from(workflowDefinitions)
        .where(
          and(
            eq(workflowDefinitions.tenantId, ctx.tenantId),
            eq(workflowDefinitions.key, m.key),
            isNull(workflowDefinitions.deletedAt),
          ),
        );
      let row: WorkflowRow;
      let version: VersionRow;
      if (existing) {
        if (!replace)
          throw new ConflictException({
            code: 'WORKFLOW_EXISTS',
            message: `Đã có Workflow mã "${m.key}"`,
          });
        version = await this.insertVersion(
          tx,
          ctx,
          existing.id,
          existing.version + 1,
          m.graph,
          `Nhập từ tệp (phiên bản ${m.version} của tệp)`,
        );
        [row] = (await tx
          .update(workflowDefinitions)
          .set({
            name: m.name,
            description: m.description,
            status: 'paused',
            version: version.version,
            updatedAt: new Date(),
          })
          .where(eq(workflowDefinitions.id, existing.id))
          .returning()) as [WorkflowRow];
      } else {
        ({ row, version } = await this.insert(
          tx,
          ctx,
          {
            key: m.key,
            name: m.name,
            description: m.description,
            source: 'imported',
            status: 'paused',
          },
          m.graph,
          `Nhập từ tệp (phiên bản ${m.version} của tệp)`,
        ));
      }
      await this.log(tx, ctx, 'workflow.imported', row.id, {
        key: m.key,
        verified: !!m.checksum,
        replaced: !!existing,
      });
      return { row, version };
    }
  }

  /** Turns a workflow on or off inside a caller's transaction (plugin activation and pause). */
  async setStatusIn(tx: Tx, ctx: Ctx, id: string, status: 'active' | 'paused'): Promise<void> {
    const current = await this.row(tx, ctx.tenantId, id);
    if (current.status === status) return;
    await tx
      .update(workflowDefinitions)
      .set({ status, updatedAt: new Date() })
      .where(eq(workflowDefinitions.id, id));
    await this.log(tx, ctx, status === 'active' ? 'workflow.activated' : 'workflow.paused', id, {
      key: current.key,
    });
  }

  async removeIn(tx: Tx, ctx: Ctx, id: string): Promise<void> {
    const row = await this.row(tx, ctx.tenantId, id);
    await tx
      .update(workflowDefinitions)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(workflowDefinitions.id, id));
    await this.log(tx, ctx, 'workflow.deleted', id, { key: row.key });
  }

  async row(tx: Tx, tenantId: string, id: string): Promise<WorkflowRow> {
    const [row] = await tx
      .select()
      .from(workflowDefinitions)
      .where(
        and(
          eq(workflowDefinitions.id, id),
          eq(workflowDefinitions.tenantId, tenantId),
          isNull(workflowDefinitions.deletedAt),
        ),
      );
    if (!row)
      throw new NotFoundException({
        code: 'WORKFLOW_NOT_FOUND',
        message: 'Không tìm thấy Workflow',
      });
    return row;
  }

  /** The current version's graph of a workflow, by key; for webhook connectors. */
  async findByKey(
    tx: Tx,
    tenantId: string,
    key: string,
  ): Promise<{ id: string; graph: WorkflowGraph } | null> {
    const [row] = await tx
      .select()
      .from(workflowDefinitions)
      .where(
        and(
          eq(workflowDefinitions.tenantId, tenantId),
          eq(workflowDefinitions.key, key),
          isNull(workflowDefinitions.deletedAt),
        ),
      );
    if (!row) return null;
    const v = await this.version(tx, row.id, row.version);
    return { id: row.id, graph: v.graph as WorkflowGraph };
  }

  async version(tx: Tx, workflowId: string, version: number): Promise<VersionRow> {
    const [v] = await tx
      .select()
      .from(workflowVersions)
      .where(
        and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.version, version)),
      );
    if (!v)
      throw new NotFoundException({
        code: 'WORKFLOW_VERSION_NOT_FOUND',
        message: `Không có phiên bản ${version}`,
      });
    return v;
  }

  activeSkills(tx: Tx, tenantId: string) {
    return tx
      .select()
      .from(aiSkills)
      .where(and(eq(aiSkills.tenantId, tenantId), isNull(aiSkills.deletedAt)));
  }

  /** Every skill and agent the steps name must exist (they may be paused; a run checks again). */
  async assertReferences(tx: Tx, tenantId: string, graph: WorkflowGraph): Promise<void> {
    const skillKeys = [
      ...new Set(graph.nodes.flatMap((n) => (n.type === 'skill' ? [n.skillKey] : []))),
    ];
    const agentKeys = [
      ...new Set(
        graph.nodes.flatMap((n) =>
          (n.type === 'skill' || n.type === 'ai') && n.agentKey ? [n.agentKey] : [],
        ),
      ),
    ];
    const missing: string[] = [];
    if (skillKeys.length) {
      const found = await tx
        .select({ key: aiSkills.key, manifest: aiSkills.manifest })
        .from(aiSkills)
        .where(
          and(
            eq(aiSkills.tenantId, tenantId),
            inArray(aiSkills.key, skillKeys),
            isNull(aiSkills.deletedAt),
          ),
        );
      for (const k of skillKeys) if (!found.some((f) => f.key === k)) missing.push(`Skill "${k}"`);
      for (const n of graph.nodes) {
        if (n.type !== 'skill') continue;
        const s = found.find((f) => f.key === n.skillKey);
        if (!s) continue;
        const unknown = Object.keys(n.inputs).filter(
          (name) => !s.manifest.inputs.some((f) => f.name === name),
        );
        if (unknown.length) {
          throw new BadRequestException({
            code: 'WORKFLOW_INVALID',
            message: `Bước "${n.label}": Skill "${n.skillKey}" không có ô ${unknown.join(', ')}`,
          });
        }
      }
    }
    if (agentKeys.length) {
      const found = await tx
        .select({ key: aiAgents.key })
        .from(aiAgents)
        .where(
          and(
            eq(aiAgents.tenantId, tenantId),
            inArray(aiAgents.key, agentKeys),
            isNull(aiAgents.deletedAt),
          ),
        );
      for (const k of agentKeys) if (!found.some((f) => f.key === k)) missing.push(`Agent "${k}"`);
    }
    const connectorNodes = graph.nodes.flatMap((n) => (n.type === 'connector' ? [n] : []));
    if (connectorNodes.length) {
      const found = await tx
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.tenantId, tenantId),
            inArray(connectors.key, [...new Set(connectorNodes.map((n) => n.connectorKey))]),
            isNull(connectors.deletedAt),
          ),
        );
      for (const n of connectorNodes) {
        const c = found.find((f) => f.key === n.connectorKey && f.kind === 'http');
        if (!c) {
          missing.push(`Connector "${n.connectorKey}"`);
          continue;
        }
        const cap = c.capabilities.find((x) => x.key === n.capability);
        if (!cap) {
          missing.push(`thao tác "${n.capability}" của Connector "${n.connectorKey}"`);
          continue;
        }
        const unknown = Object.keys(n.inputs).filter(
          (name) => !cap.inputs.some((f) => f.name === name),
        );
        if (unknown.length) {
          throw new BadRequestException({
            code: 'WORKFLOW_INVALID',
            message: `Bước "${n.label}": thao tác "${n.capability}" không có ô ${unknown.join(', ')}`,
          });
        }
      }
    }
    if (missing.length) {
      throw new BadRequestException({
        code: 'WORKFLOW_REFERENCE_MISSING',
        message: `Workflow dùng thứ chưa có ở đây: ${missing.join(', ')}`,
      });
    }
  }

  private async assertKeyFree(tx: Tx, tenantId: string, key: string): Promise<void> {
    const [dup] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(
        and(
          eq(workflowDefinitions.tenantId, tenantId),
          eq(workflowDefinitions.key, key),
          isNull(workflowDefinitions.deletedAt),
        ),
      );
    if (dup)
      throw new ConflictException({
        code: 'WORKFLOW_EXISTS',
        message: `Đã có Workflow mã "${key}"`,
      });
  }

  private async insert(
    tx: Tx,
    ctx: Ctx,
    d: Pick<WorkflowRow, 'key' | 'name' | 'description' | 'source' | 'status'>,
    graph: WorkflowGraph,
    note: string | null,
  ): Promise<{ row: WorkflowRow; version: VersionRow }> {
    const [row] = await tx
      .insert(workflowDefinitions)
      .values({ id: uuidv7(), tenantId: ctx.tenantId, ...d, version: 1, createdBy: ctx.userId })
      .returning();
    const version = await this.insertVersion(tx, ctx, row!.id, 1, graph, note);
    return { row: row!, version };
  }

  private async insertVersion(
    tx: Tx,
    ctx: Ctx,
    workflowId: string,
    version: number,
    graph: WorkflowGraph,
    note: string | null,
  ): Promise<VersionRow> {
    const [v] = await tx
      .insert(workflowVersions)
      .values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        workflowId,
        version,
        graph: graph as schema.WorkGraphData,
        checksum: graphChecksum(graph),
        note,
        createdBy: ctx.userId,
      })
      .returning();
    return v!;
  }

  private log(tx: Tx, ctx: Ctx, action: string, id: string, metadata?: Record<string, unknown>) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'workflow',
      targetId: id,
      metadata,
      ip: ctx.ip,
    });
  }
}

export function response(r: WorkflowRow, v: VersionRow): WorkflowResponse {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    source: r.source,
    status: r.status,
    version: r.version,
    graph: v.graph as WorkflowGraph,
    checksum: v.checksum,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
