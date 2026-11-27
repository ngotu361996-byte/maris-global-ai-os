import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import { ACCESS_LEVEL_LABEL, levelAtLeast, MODE_CAPABILITY, type AccessLevel, type AiActivityResponse, type CreateTask, type TaskResponse, type TaskStatus as AiTaskStatus } from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { OutboxService } from '../outbox/outbox.service';
import { RedisService } from '../redis/redis.module';
import { SecretVaultService } from '../secrets/secret-vault.service';
import type { ChatTurn } from './adapters';
import { AgentsService } from './agents.service';
import { AiProvidersService } from './ai-providers.service';
import { AiRouterService, type ProviderRow, type RouteResult } from './ai-router.service';
import { orderCandidates, systemPrompt, type Ctx } from './chat.service';
import { ControlService, estopKey, taskAbortKey } from './control.service';
import { CostGovernorService } from './cost-governor.service';
import { MemoryService } from './memory.service';
import { applyRegistry, ModelsService } from './models.service';

const { aiTasks, aiProviderCalls } = schema;
type TaskRow = typeof aiTasks.$inferSelect;

export const TASKS_QUEUE = 'maris-tasks';
interface TaskJob {
  tenantId: string;
  taskId: string;
  /** The approver: the run acts with their tenant context. */
  userId: string;
}

const OPEN: AiTaskStatus[] = ['pending', 'queued', 'running', 'paused'];

/**
 * Structured Task: a command becomes a task with goal, scope, permissions, budget and success
 * criteria, and nothing runs until someone with ai.approve approves it. Approved tasks run on the
 * maris-tasks queue; pause, cancel and Emergency Stop abort a running task through Redis flags.
 * A run only produces text with an AI, so running it again after a crash repeats no external action.
 */
@Injectable()
export class TasksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Tasks');
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];
  /** Told when a task ends or stops, so a workflow waiting on it can move on. */
  private readonly finishedListeners: ((tenantId: string, taskId: string) => Promise<void>)[] = [];

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly providers: AiProvidersService,
    private readonly router: AiRouterService,
    private readonly vault: SecretVaultService,
    private readonly agents: AgentsService,
    private readonly memory: MemoryService,
    private readonly control: ControlService,
    private readonly governor: CostGovernorService,
    private readonly models: ModelsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.AI_TASK_WORKER_ENABLED) return;
    const connection = this.redis.duplicate();
    this.connections.push(connection);
    this.worker = new Worker<TaskJob>(TASKS_QUEUE, (job: Job<TaskJob>) => this.run(job.data), { connection, concurrency: 2 });
    this.worker.on('failed', (job, err) => this.logger.error(`task ${job?.data.taskId} failed: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    for (const c of this.connections) await c.quit().catch(() => undefined);
  }

  list(ctx: Ctx, status?: AiTaskStatus): Promise<TaskResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(aiTasks)
        .where(and(eq(aiTasks.tenantId, ctx.tenantId), status ? eq(aiTasks.status, status) : undefined))
        .orderBy(desc(aiTasks.updatedAt))
        .limit(200);
      return rows.map(taskResponse);
    });
  }

  get(ctx: Ctx, id: string): Promise<TaskResponse> {
    return this.db.withContext(ctx, async (tx) => taskResponse(await this.row(tx, ctx.tenantId, id)));
  }

  activity(ctx: Ctx): Promise<AiActivityResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const open = await tx
        .select()
        .from(aiTasks)
        .where(and(eq(aiTasks.tenantId, ctx.tenantId), inArray(aiTasks.status, ['pending', 'queued', 'running'])))
        .orderBy(desc(aiTasks.updatedAt));
      const budgets = await this.governor.list(tx, ctx.tenantId);
      return {
        control: await this.control.state(tx, ctx.tenantId),
        pending: open.filter((t) => t.status === 'pending').length,
        queued: open.filter((t) => t.status === 'queued').length,
        running: open.filter((t) => t.status === 'running').map(taskResponse),
        budgetWarnings: budgets.filter((b) => b.state !== 'ok').length,
      };
    });
  }

  create(ctx: Ctx, body: CreateTask): Promise<TaskResponse> {
    return this.db.withContext(ctx, async (tx) => taskResponse(await this.insert(tx, ctx, body)));
  }

  onFinished(listener: (tenantId: string, taskId: string) => Promise<void>): void {
    this.finishedListeners.push(listener);
  }

  private async notifyFinished(tenantId: string, taskId: string): Promise<void> {
    for (const l of this.finishedListeners) await l(tenantId, taskId).catch((e: Error) => this.logger.error(`finished listener: ${e.message}`));
  }

  /**
   * Creates a pending task. Also used by AI Central Command for the steps of an accepted plan, and
   * by workflows, whose tasks arrive already approved by the person who started the run.
   */
  async insert(tx: Tx, ctx: Ctx, body: CreateTask & TaskOrigin): Promise<TaskRow> {
    const requiredLevel = body.requiredLevel ?? 'prepare';
    if (body.agentId) assertLevel(await this.agents.get(tx, ctx.tenantId, body.agentId), requiredLevel);
    if (body.projectId) await this.memory.project(tx, ctx.tenantId, body.projectId);
    const [row] = await tx
      .insert(aiTasks)
      .values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        createdBy: ctx.userId,
        title: body.title,
        goal: body.goal,
        scope: body.scope,
        successCriteria: body.successCriteria,
        permissions: ['ai.generate_text'],
        budgetUsd: String(body.budgetUsd),
        agentId: body.agentId ?? null,
        projectId: body.projectId ?? null,
        conversationId: body.conversationId ?? null,
        planId: body.planId ?? null,
        stepIndex: body.stepIndex ?? null,
        requiredLevel,
        skillId: body.skill?.id ?? null,
        skillVersion: body.skill?.version ?? null,
        skillPrompt: body.skill?.prompt ?? body.workflow?.prompt ?? body.content?.prompt ?? null,
        timeoutSec: body.skill?.timeoutSec ?? body.timeoutSec ?? null,
        contentItemId: body.content?.itemId ?? null,
        workflowRunId: body.workflow?.runId ?? null,
        workflowNodeId: body.workflow?.nodeId ?? null,
        ...(body.approvedBy
          ? { status: 'queued' as const, approvedBy: body.approvedBy, approvedAt: new Date(), progress: body.content ? 'Đã duyệt khi yêu cầu AI viết, đang chờ chạy' : 'Đã duyệt khi bắt đầu Workflow, đang chờ chạy' }
          : {}),
      })
      .returning();
    await this.log(tx, ctx, 'ai.task.created', row!.id, {
      budgetUsd: body.budgetUsd,
      requiredLevel,
      planId: body.planId ?? null,
      skillId: body.skill?.id ?? null,
      workflowRunId: body.workflow?.runId ?? null,
    });
    await this.outbox.enqueue(tx, { tenantId: ctx.tenantId, type: 'ai.task.created', payload: { taskId: row!.id } });
    return row!;
  }

  async approve(ctx: Ctx, id: string, note: string | null): Promise<TaskResponse> {
    const task = await this.db.withContext(ctx, async (tx) => {
      await this.control.assertRunning(tx, ctx.tenantId);
      const current = await this.row(tx, ctx.tenantId, id);
      expectStatus(current, ['pending']);
      const row = await this.setStatus(tx, id, 'queued', {
        approvedBy: ctx.userId,
        approvedAt: new Date(),
        decisionNote: note,
        progress: 'Đã duyệt, đang chờ chạy',
      });
      await this.log(tx, ctx, 'ai.task.approved', id, { note: note ? true : false });
      await this.outbox.enqueue(tx, { tenantId: ctx.tenantId, type: 'ai.task.approved', payload: { taskId: id } });
      return row;
    });
    await this.enqueue(ctx.tenantId, id, ctx.userId);
    return taskResponse(task);
  }

  reject(ctx: Ctx, id: string, note: string | null): Promise<TaskResponse> {
    return this.db.withContext(ctx, async (tx) => {
      expectStatus(await this.row(tx, ctx.tenantId, id), ['pending']);
      const row = await this.setStatus(tx, id, 'rejected', { decisionNote: note, finishedAt: new Date(), progress: null });
      await this.log(tx, ctx, 'ai.task.rejected', id);
      return taskResponse(row);
    });
  }

  /** The creator or an approver may pause a queued or running task. */
  async pause(ctx: Ctx, id: string, canApprove: boolean): Promise<TaskResponse> {
    const row = await this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      assertOwnerOrApprover(current, ctx, canApprove);
      expectStatus(current, ['queued', 'running']);
      const r = await this.setStatus(tx, id, 'paused', { progress: 'Tạm dừng' });
      await this.log(tx, ctx, 'ai.task.paused', id);
      return r;
    });
    await this.redis.client.set(taskAbortKey(id), '1', 'EX', 3600);
    return taskResponse(row);
  }

  /** Running again needs an approver, like the first run. Paused and failed tasks can be resumed. */
  async resume(ctx: Ctx, id: string): Promise<TaskResponse> {
    const row = await this.db.withContext(ctx, async (tx) => {
      await this.control.assertRunning(tx, ctx.tenantId);
      const current = await this.row(tx, ctx.tenantId, id);
      expectStatus(current, ['paused', 'failed']);
      // Its content run has already ended; a new run starts from the item, with the facts as they are now.
      if (current.contentItemId) {
        throw new BadRequestException({ code: 'AI_TASK_CONTENT', message: 'Việc AI viết nội dung không chạy lại được. Hãy bấm “AI viết” lại ở Kho thành phẩm.' });
      }
      const r = await this.setStatus(tx, id, 'queued', { approvedBy: ctx.userId, approvedAt: new Date(), errorCode: null, progress: 'Đang chờ chạy lại' });
      await this.log(tx, ctx, 'ai.task.resumed', id);
      return r;
    });
    await this.redis.client.del(taskAbortKey(id));
    await this.enqueue(ctx.tenantId, id, ctx.userId);
    return taskResponse(row);
  }

  async cancel(ctx: Ctx, id: string, canApprove: boolean): Promise<TaskResponse> {
    const row = await this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      assertOwnerOrApprover(current, ctx, canApprove);
      expectStatus(current, OPEN);
      const r = await this.setStatus(tx, id, 'cancelled', { finishedAt: new Date(), progress: null });
      await this.log(tx, ctx, 'ai.task.cancelled', id);
      return r;
    });
    await this.redis.client.set(taskAbortKey(id), '1', 'EX', 3600);
    await this.notifyFinished(ctx.tenantId, id);
    return taskResponse(row);
  }

  /** Cancels an open task inside the caller's transaction; call abort() after it commits. */
  async cancelInTx(tx: Tx, tenantId: string, id: string): Promise<boolean> {
    const current = await this.row(tx, tenantId, id);
    if (!OPEN.includes(current.status)) return false;
    await this.setStatus(tx, id, 'cancelled', { finishedAt: new Date(), progress: null });
    return true;
  }

  /** Stops a running AI call of a cancelled task. */
  async abort(id: string): Promise<void> {
    await this.redis.client.set(taskAbortKey(id), '1', 'EX', 3600);
  }

  /** Puts an already-approved task on the queue. */
  start(tenantId: string, taskId: string, userId: string): Promise<void> {
    return this.enqueue(tenantId, taskId, userId);
  }

  /** Worker entry point. Claims the task (queued → running) so a duplicate job does nothing. */
  async run(job: TaskJob): Promise<void> {
    try {
      await this.execute(job);
    } finally {
      await this.notifyFinished(job.tenantId, job.taskId);
    }
  }

  private async execute(job: TaskJob): Promise<void> {
    const ctx: Ctx = { tenantId: job.tenantId, userId: job.userId, ip: null };
    const prepared = await this.db.withContext(ctx, async (tx) => {
      const [claimed] = await tx
        .update(aiTasks)
        .set({ status: 'running', startedAt: new Date(), progress: 'Đang chuẩn bị', updatedAt: new Date() })
        .where(and(eq(aiTasks.id, job.taskId), eq(aiTasks.tenantId, job.tenantId), eq(aiTasks.status, 'queued')))
        .returning();
      if (!claimed) return null;
      await tx.update(aiTasks).set({ attempts: claimed.attempts + 1 }).where(eq(aiTasks.id, claimed.id));
      try {
        await this.control.assertRunning(tx, job.tenantId);
        if (Number(claimed.costUsd) >= Number(claimed.budgetUsd)) {
          throw new BadRequestException({ code: 'TASK_BUDGET_EXCEEDED', message: 'Công việc đã dùng hết ngân sách được duyệt' });
        }
        const agent = claimed.agentId ? await this.agents.get(tx, job.tenantId, claimed.agentId) : null;
        if (agent && agent.status !== 'active') throw new BadRequestException({ code: 'AI_AGENT_PAUSED', message: `${agent.name} đang tạm dừng` });
        // Checked again at run time: an administrator may have lowered the agent's level since.
        if (agent) assertLevel(agent, claimed.requiredLevel);
        const project = claimed.projectId ? await this.memory.project(tx, job.tenantId, claimed.projectId) : null;
        const memory = project ? await this.memory.promptBlock(tx, project) : null;
        const rows = (await this.providers.rows(tx, job.tenantId)).filter((p) => p.enabled);
        const ordered = orderCandidates(rows, agent?.providerId ?? null, agent?.model ?? null);
        const registered = applyRegistry(ordered, await this.models.rows(tx, job.tenantId), MODE_CAPABILITY.expert);
        const candidates = await this.governor.filter(tx, job.tenantId, registered);
        const messages: ChatTurn[] = [
          { role: 'system', content: systemPrompt({ mode: 'expert', agent, memory }) },
          { role: 'user', content: taskPrompt(claimed) },
        ];
        return { task: claimed, candidates, messages };
      } catch (err) {
        const e = err as { response?: { code?: string; message?: string }; message?: string };
        const code = e.response?.code ?? 'TASK_START_FAILED';
        const status: AiTaskStatus = code === 'EMERGENCY_STOP' ? 'paused' : 'failed';
        await this.setStatus(tx, claimed.id, status, {
          errorCode: code,
          progress: e.response?.message ?? e.message ?? null,
          finishedAt: status === 'failed' ? new Date() : null,
        });
        return null;
      }
    });
    if (!prepared) return;

    const abort = new AbortController();
    const unwatch = this.control.watch([taskAbortKey(job.taskId), estopKey(job.tenantId)], abort);
    // A skill's timeout: abort the AI call and record the task as failed, not paused.
    let timedOut = false;
    const timer = prepared.task.timeoutSec
      ? setTimeout(() => {
          timedOut = true;
          abort.abort();
        }, prepared.task.timeoutSec * 1000)
      : null;
    let result: RouteResult;
    try {
      result = await this.router.route({
        candidates: prepared.candidates,
        messages: prepared.messages,
        signal: abort.signal,
        emit: (ev) => {
          if (ev.type === 'provider') void this.progress(ctx, job.taskId, `${ev.name} (${ev.model}) đang thực hiện`);
          else if (ev.type === 'failover') void this.progress(ctx, job.taskId, 'AI chính lỗi, đang chuyển sang AI dự phòng');
        },
        resolveKey: (p: ProviderRow) =>
          p.secretRef ? this.db.withContext(ctx, (tx) => this.vault.resolve(tx, job.tenantId, p.secretRef!)) : Promise.resolve(null),
      });
    } finally {
      unwatch();
      if (timer) clearTimeout(timer);
    }
    if (timedOut && result.status === 'cancelled') {
      result = { ...result, status: 'error' as const, errorCode: 'TASK_TIMEOUT', errorMessage: `Quá thời gian cho phép (${prepared.task.timeoutSec} giây)` };
    }

    await this.db.withContext(ctx, async (tx) => {
      if (result.calls.length) {
        await tx.insert(aiProviderCalls).values(
          result.calls.map((c) => ({
            id: uuidv7(),
            tenantId: job.tenantId,
            taskId: job.taskId,
            providerId: c.providerId,
            model: c.model,
            outcome: c.outcome,
            errorCode: c.errorCode,
            inputTokens: c.inputTokens,
            outputTokens: c.outputTokens,
            costUsd: c.costUsd == null ? null : String(c.costUsd),
            latencyMs: c.latencyMs,
          })),
        );
      }
      const [current] = await tx.select().from(aiTasks).where(eq(aiTasks.id, job.taskId));
      const cost = String(Number(current!.costUsd) + (result.costUsd ?? 0));
      // Paused or cancelled meanwhile (by a person or Emergency Stop): keep that status, record only the cost.
      if (current!.status !== 'running') {
        await tx.update(aiTasks).set({ costUsd: cost, updatedAt: new Date() }).where(eq(aiTasks.id, job.taskId));
      } else if (result.status === 'complete') {
        await this.setStatus(tx, job.taskId, 'completed', { result: result.content, costUsd: cost, progress: 'Hoàn thành', finishedAt: new Date() });
        await this.outbox.enqueue(tx, { tenantId: job.tenantId, type: 'ai.task.completed', payload: { taskId: job.taskId, costUsd: result.costUsd } });
      } else if (result.status === 'cancelled') {
        await this.setStatus(tx, job.taskId, 'paused', { costUsd: cost, progress: 'Tạm dừng' });
      } else {
        await this.setStatus(tx, job.taskId, 'failed', {
          costUsd: cost,
          errorCode: result.errorCode,
          progress: result.errorMessage,
          finishedAt: new Date(),
        });
        await this.outbox.enqueue(tx, { tenantId: job.tenantId, type: 'ai.task.failed', payload: { taskId: job.taskId, errorCode: result.errorCode } });
      }
      await this.audit.append(tx, {
        tenantId: job.tenantId,
        actorUserId: null,
        action: 'ai.task.run_finished',
        targetType: 'ai_task',
        targetId: job.taskId,
        metadata: { outcome: result.status, attempts: result.calls.length, costUsd: result.costUsd },
      });
      await this.governor.afterSpend(tx, job.tenantId);
    });
  }

  private async progress(ctx: Ctx, id: string, text: string): Promise<void> {
    await this.db
      .withContext(ctx, (tx) =>
        tx.update(aiTasks).set({ progress: text, updatedAt: new Date() }).where(and(eq(aiTasks.id, id), eq(aiTasks.status, 'running'))),
      )
      .catch(() => undefined);
  }

  private async enqueue(tenantId: string, taskId: string, userId: string): Promise<void> {
    if (!this.queue) {
      const connection = this.redis.duplicate();
      this.connections.push(connection);
      this.queue = new Queue(TASKS_QUEUE, { connection });
    }
    await this.queue.add('run', { tenantId, taskId, userId } satisfies TaskJob, { removeOnComplete: 1000, removeOnFail: 1000 });
  }

  private async row(tx: Tx, tenantId: string, id: string): Promise<TaskRow> {
    const [row] = await tx.select().from(aiTasks).where(and(eq(aiTasks.id, id), eq(aiTasks.tenantId, tenantId)));
    if (!row) throw new NotFoundException({ code: 'AI_TASK_NOT_FOUND', message: 'Không tìm thấy công việc' });
    return row;
  }

  private async setStatus(tx: Tx, id: string, status: AiTaskStatus, extra: Partial<TaskRow> = {}): Promise<TaskRow> {
    const [row] = await tx
      .update(aiTasks)
      .set({ ...extra, status, updatedAt: new Date() })
      .where(eq(aiTasks.id, id))
      .returning();
    return row!;
  }

  private log(tx: Tx, ctx: Ctx, action: string, id: string, metadata?: Record<string, unknown>) {
    return this.audit.append(tx, { tenantId: ctx.tenantId, actorUserId: ctx.userId, action, targetType: 'ai_task', targetId: id, metadata, ip: ctx.ip });
  }
}

function expectStatus(task: TaskRow, allowed: AiTaskStatus[]): void {
  if (!allowed.includes(task.status)) {
    throw new BadRequestException({ code: 'AI_TASK_WRONG_STATUS', message: `Công việc đang ở trạng thái "${task.status}", không làm được thao tác này` });
  }
}

/** Where a task came from, besides a person filling in the form. */
export interface TaskOrigin {
  planId?: string;
  stepIndex?: number;
  skill?: { id: string; version: string; prompt: string; timeoutSec: number };
  /** Instructions of a workflow AI step, sent as they are without the task frame's self-review. */
  workflow?: { runId: string; nodeId: string; prompt?: string };
  timeoutSec?: number;
  /** AI content writing: the prompt MARIS built from verified facts, sent as it is. */
  content?: { itemId: string; prompt: string };
  /** Set by workflows and content writing: the task is created approved, by the person who asked. */
  approvedBy?: string;
}

/** An agent may only take work at or below its access level, which only a person can change. */
export function assertLevel(agent: { name: string; accessLevel: AccessLevel }, needs: AccessLevel): void {
  if (!levelAtLeast(agent.accessLevel, needs)) {
    throw new BadRequestException({
      code: 'AGENT_LEVEL_TOO_LOW',
      message: `${agent.name} có quyền "${ACCESS_LEVEL_LABEL[agent.accessLevel]}", công việc cần "${ACCESS_LEVEL_LABEL[needs]}"`,
    });
  }
}

function assertOwnerOrApprover(task: TaskRow, ctx: Ctx, canApprove: boolean): void {
  if (task.createdBy !== ctx.userId && !canApprove) {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Chỉ người tạo hoặc người có quyền phê duyệt mới làm được' });
  }
}

/** The task, as the AI sees it. The fields are the tenant's own text, framed as the work to do. */
export function taskPrompt(
  t: Pick<TaskRow, 'title' | 'goal' | 'scope' | 'successCriteria' | 'requiredLevel' | 'skillPrompt'> & Partial<Pick<TaskRow, 'workflowNodeId' | 'skillId' | 'contentItemId'>>,
): string {
  // AI content writing: the brief decides the answer's form; the answer is saved as the text itself.
  if (t.contentItemId && t.skillPrompt) {
    return ['Quyền hạn: chỉ được soạn nội dung văn bản; không thực hiện, không giả vờ đã thực hiện hành động bên ngoài.', '', t.skillPrompt].join('\n');
  }
  // A workflow AI step: its own instructions decide the answer's form (a condition may read it).
  if (t.workflowNodeId && !t.skillId && t.skillPrompt) {
    return [
      'Quyền hạn: chỉ được soạn nội dung văn bản; không thực hiện, không giả vờ đã thực hiện hành động bên ngoài.',
      `Mức quyền: ${ACCESS_LEVEL_LABEL[t.requiredLevel]}`,
      '',
      t.skillPrompt,
    ].join('\n');
  }
  const lines = [
    'Thực hiện công việc đã được phê duyệt dưới đây và trả về sản phẩm hoàn chỉnh (văn bản).',
    'Quyền hạn: chỉ được soạn nội dung văn bản; không thực hiện, không giả vờ đã thực hiện hành động bên ngoài (đăng bài, gửi tin, chi tiền, sửa dữ liệu).',
    'Nếu một phần cần hành động bên ngoài, ghi rõ bước đó để người dùng tự làm hoặc duyệt ở giai đoạn sau.',
    `Mức quyền của công việc: ${ACCESS_LEVEL_LABEL[t.requiredLevel]}`,
    `Tên công việc: ${t.title}`,
    `Mục tiêu: ${t.goal}`,
    `Phạm vi: ${t.scope}`,
    `Tiêu chí hoàn thành: ${t.successCriteria}`,
    'Cuối câu trả lời, tự đánh giá ngắn sản phẩm theo từng tiêu chí hoàn thành.',
  ];
  if (t.skillPrompt) lines.push('', t.skillPrompt);
  return lines.join('\n');
}

export function taskResponse(r: TaskRow): TaskResponse {
  return {
    id: r.id,
    title: r.title,
    goal: r.goal,
    scope: r.scope,
    successCriteria: r.successCriteria,
    permissions: r.permissions,
    budgetUsd: Number(r.budgetUsd),
    agentId: r.agentId,
    projectId: r.projectId,
    conversationId: r.conversationId,
    planId: r.planId,
    stepIndex: r.stepIndex,
    requiredLevel: r.requiredLevel as TaskResponse['requiredLevel'],
    skillId: r.skillId,
    skillVersion: r.skillVersion,
    workflowRunId: r.workflowRunId,
    status: r.status,
    progress: r.progress,
    createdBy: r.createdBy,
    approvedBy: r.approvedBy,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    decisionNote: r.decisionNote,
    result: r.result,
    costUsd: Number(r.costUsd),
    attempts: r.attempts,
    errorCode: r.errorCode,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
