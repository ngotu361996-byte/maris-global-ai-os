import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import type Redis from 'ioredis';
import { and, asc, desc, eq, isNull, max } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  type StartWorkflowRun,
  type TaskLevel,
  type TestWorkflow,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowRunDetailResponse,
  type WorkflowRunResponse,
  type WorkflowTestResponse,
} from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { OutboxService } from '../outbox/outbox.service';
import { RedisService } from '../redis/redis.module';
import type { Ctx } from '../ai/chat.service';
import { ControlService } from '../ai/control.service';
import { checkInputs, skillTaskBody } from '../ai/skills.service';
import { assertLevel, TasksService } from '../ai/tasks.service';
import {
  conditionText,
  evaluate,
  following,
  nodeOf,
  render,
  renderForAi,
  simulate,
  type RunState,
} from './workflow-engine';
import { WorkflowsService } from './workflows.service';

const { workflowRuns, workflowRunSteps, aiTasks, aiSkills, aiAgents } = schema;
type RunRow = typeof workflowRuns.$inferSelect;
type StepRow = typeof workflowRunSteps.$inferSelect;
type TaskRow = typeof aiTasks.$inferSelect;

export const WORKFLOWS_QUEUE = 'maris-workflows';
interface WorkflowJob {
  tenantId: string;
  runId?: string;
  /** A task finished: find its run, if it has one. */
  taskId?: string;
}

const TASK_OPEN: TaskRow['status'][] = ['pending', 'queued', 'running', 'paused'];
const OUTPUT_CHARS = 100_000;

class StepError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Runs workflows. A run moves step by step in the maris-workflows queue, holding a row lock so two
 * jobs never move the same run. AI and skill steps become tasks that the person who started the run
 * approved by starting it; the run waits for each task and continues when it ends. Approval steps
 * wait for a person. The step limit and the run budget stop loops and runaway cost.
 */
@Injectable()
export class WorkflowRunsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Workflows');
  private queue?: Queue;
  private worker?: Worker;
  private connections: Redis[] = [];

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly workflows: WorkflowsService,
    private readonly tasks: TasksService,
    private readonly control: ControlService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.tasks.onFinished((tenantId, taskId) => this.enqueue({ tenantId, taskId }));
    if (!this.config.AI_TASK_WORKER_ENABLED) return;
    const connection = this.redis.duplicate();
    this.connections.push(connection);
    this.worker = new Worker<WorkflowJob>(
      WORKFLOWS_QUEUE,
      (job: Job<WorkflowJob>) => this.handle(job.data),
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(
        `workflow job ${job?.data.runId ?? job?.data.taskId} failed: ${err.message}`,
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    for (const c of this.connections) await c.quit().catch(() => undefined);
  }

  list(ctx: Ctx, workflowId: string): Promise<WorkflowRunResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.workflows.row(tx, ctx.tenantId, workflowId);
      const rows = await tx
        .select()
        .from(workflowRuns)
        .where(
          and(eq(workflowRuns.tenantId, ctx.tenantId), eq(workflowRuns.workflowId, workflowId)),
        )
        .orderBy(desc(workflowRuns.createdAt))
        .limit(50);
      return rows.map(runResponse);
    });
  }

  get(ctx: Ctx, runId: string): Promise<WorkflowRunDetailResponse> {
    return this.db.withContext(ctx, (tx) => this.detail(tx, ctx.tenantId, runId));
  }

  /** A test run: nothing is saved or spent; AI steps get placeholders. */
  test(ctx: Ctx, workflowId: string, body: TestWorkflow): Promise<WorkflowTestResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const wf = await this.workflows.row(tx, ctx.tenantId, workflowId);
      const graph = (await this.workflows.version(tx, workflowId, wf.version))
        .graph as WorkflowGraph;
      const trigger = graph.nodes[0] as Extract<WorkflowNode, { type: 'trigger' }>;
      const input = checkInputs(trigger.inputs, body.inputs);
      const skills = await this.workflows.activeSkills(tx, ctx.tenantId);
      return simulate(graph, input, (key) =>
        Number(skills.find((s) => s.key === key)?.budgetUsd ?? 0),
      );
    });
  }

  /** Starting a run approves its AI spend up to the run budget, so it needs ai.approve. */
  async start(
    ctx: Ctx,
    workflowId: string,
    body: StartWorkflowRun,
  ): Promise<WorkflowRunDetailResponse> {
    const run = await this.db.withContext(ctx, async (tx) => {
      await this.control.assertRunning(tx, ctx.tenantId);
      const wf = await this.workflows.row(tx, ctx.tenantId, workflowId);
      if (wf.status !== 'active')
        throw new BadRequestException({
          code: 'WORKFLOW_PAUSED',
          message: `Workflow "${wf.name}" đang tắt`,
        });
      const graph = (await this.workflows.version(tx, workflowId, wf.version))
        .graph as WorkflowGraph;
      const trigger = graph.nodes[0] as Extract<WorkflowNode, { type: 'trigger' }>;
      const input = checkInputs(trigger.inputs, body.inputs);
      const [row] = await tx
        .insert(workflowRuns)
        .values({
          id: uuidv7(),
          tenantId: ctx.tenantId,
          workflowId,
          version: wf.version,
          status: 'running',
          input,
          currentNode: trigger.id,
          budgetUsd: String(body.budgetUsd),
          startedBy: ctx.userId,
        })
        .returning();
      await this.log(tx, ctx, 'workflow.run.started', row!.id, {
        workflowId,
        version: wf.version,
        budgetUsd: body.budgetUsd,
      });
      return row!;
    });
    await this.enqueue({ tenantId: ctx.tenantId, runId: run.id });
    return this.get(ctx, run.id);
  }

  approve(ctx: Ctx, runId: string, note: string | undefined): Promise<WorkflowRunDetailResponse> {
    return this.decide(ctx, runId, true, note);
  }

  reject(ctx: Ctx, runId: string, note: string | undefined): Promise<WorkflowRunDetailResponse> {
    return this.decide(ctx, runId, false, note);
  }

  /** The starter or an approver may pause; a step already with the AI finishes and is kept. */
  pause(ctx: Ctx, runId: string, canApprove: boolean): Promise<WorkflowRunDetailResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const run = await this.lock(tx, ctx.tenantId, runId);
      if (run.startedBy !== ctx.userId && !canApprove) throw forbidden();
      expectStatus(run, ['running', 'waiting_approval']);
      await this.setRun(tx, runId, { status: 'paused' });
      await this.log(tx, ctx, 'workflow.run.paused', runId);
      return this.detail(tx, ctx.tenantId, runId);
    });
  }

  async resume(ctx: Ctx, runId: string): Promise<WorkflowRunDetailResponse> {
    await this.db.withContext(ctx, async (tx) => {
      await this.control.assertRunning(tx, ctx.tenantId);
      const run = await this.lock(tx, ctx.tenantId, runId);
      expectStatus(run, ['paused']);
      await this.setRun(tx, runId, {
        status: run.wait?.kind === 'approval' ? 'waiting_approval' : 'running',
      });
      await this.log(tx, ctx, 'workflow.run.resumed', runId);
    });
    await this.enqueue({ tenantId: ctx.tenantId, runId });
    return this.get(ctx, runId);
  }

  async cancel(ctx: Ctx, runId: string, canApprove: boolean): Promise<WorkflowRunDetailResponse> {
    let abort: string | null = null;
    const detail = await this.db.withContext(ctx, async (tx) => {
      const run = await this.lock(tx, ctx.tenantId, runId);
      if (run.startedBy !== ctx.userId && !canApprove) throw forbidden();
      expectStatus(run, ['running', 'waiting_approval', 'paused']);
      if (
        run.wait?.kind === 'task' &&
        (await this.tasks.cancelInTx(tx, ctx.tenantId, run.wait.taskId))
      )
        abort = run.wait.taskId;
      await tx
        .update(workflowRunSteps)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.status, 'waiting')));
      await this.setRun(tx, runId, {
        status: 'cancelled',
        finishedAt: new Date(),
        errorMessage: 'Đã hủy',
      });
      await this.log(tx, ctx, 'workflow.run.cancelled', runId);
      return this.detail(tx, ctx.tenantId, runId);
    });
    if (abort) await this.tasks.abort(abort);
    return detail;
  }

  /** Runs a failed or cancelled run again from its last checkpoint, with the outputs saved there. */
  async restore(ctx: Ctx, runId: string): Promise<WorkflowRunDetailResponse> {
    await this.db.withContext(ctx, async (tx) => {
      await this.control.assertRunning(tx, ctx.tenantId);
      const run = await this.lock(tx, ctx.tenantId, runId);
      expectStatus(run, ['failed', 'cancelled']);
      if (!run.checkpoint)
        throw new BadRequestException({
          code: 'WORKFLOW_NO_CHECKPOINT',
          message: 'Lần chạy này chưa qua điểm lưu nào',
        });
      await this.setRun(tx, runId, {
        status: 'running',
        outputs: run.checkpoint.outputs,
        currentNode: run.checkpoint.nodeId,
        wait: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
      });
      await this.log(tx, ctx, 'workflow.run.restored', runId, { from: run.checkpoint.nodeId });
    });
    await this.enqueue({ tenantId: ctx.tenantId, runId });
    return this.get(ctx, runId);
  }

  private async decide(
    ctx: Ctx,
    runId: string,
    approved: boolean,
    note: string | undefined,
  ): Promise<WorkflowRunDetailResponse> {
    await this.db.withContext(ctx, async (tx) => {
      if (approved) await this.control.assertRunning(tx, ctx.tenantId);
      const run = await this.lock(tx, ctx.tenantId, runId);
      expectStatus(run, ['waiting_approval']);
      const graph = await this.graph(tx, run);
      const node = nodeOf(graph, run.currentNode!) as Extract<WorkflowNode, { type: 'approval' }>;
      const output = `${approved ? 'Đã duyệt' : 'Từ chối'}${note ? `: ${note}` : ''}`;
      await this.finishStep(tx, runId, 'completed', output);
      const outputs = { ...run.outputs, [node.id]: output };
      if (approved || node.onReject) {
        await this.setRun(tx, runId, {
          status: 'running',
          wait: null,
          outputs,
          currentNode: approved ? following(graph, node.id) : node.onReject,
        });
      } else {
        await this.setRun(tx, runId, {
          status: 'cancelled',
          wait: null,
          outputs,
          finishedAt: new Date(),
          errorMessage: `Bị từ chối ở bước "${node.label}"`,
        });
      }
      await this.log(tx, ctx, approved ? 'workflow.run.approved' : 'workflow.run.rejected', runId, {
        node: node.id,
        note: !!note,
      });
    });
    await this.enqueue({ tenantId: ctx.tenantId, runId });
    return this.get(ctx, runId);
  }

  /** Worker entry point. */
  async handle(job: WorkflowJob): Promise<void> {
    let runId = job.runId;
    if (!runId && job.taskId) {
      const [task] = await this.db.withContext({ tenantId: job.tenantId }, (tx) =>
        tx
          .select({ runId: aiTasks.workflowRunId })
          .from(aiTasks)
          .where(and(eq(aiTasks.id, job.taskId!), eq(aiTasks.tenantId, job.tenantId))),
      );
      runId = task?.runId ?? undefined;
    }
    if (runId) await this.advance(job.tenantId, runId);
  }

  /** Moves a run as far as it can go now: until it waits for a task, an approval, a delay, or ends. */
  async advance(tenantId: string, runId: string): Promise<void> {
    const after: (() => Promise<void>)[] = [];
    const [starter] = await this.db.withContext({ tenantId }, (tx) =>
      tx
        .select({ by: workflowRuns.startedBy })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId))),
    );
    if (!starter) return;
    const ctx: Ctx = { tenantId, userId: starter.by, ip: null };
    await this.db.withContext(ctx, async (tx) => {
      let run = await this.lock(tx, tenantId, runId);
      if (run.status !== 'running') return;
      const graph = await this.graph(tx, run);
      const state: RunState = { input: run.input, outputs: { ...run.outputs } };
      let cost = Number(run.costUsd);
      let steps = run.stepsTaken;
      const save = (patch: Partial<RunRow>) =>
        this.setRun(tx, runId, {
          outputs: state.outputs,
          costUsd: String(cost),
          stepsTaken: steps,
          ...patch,
        });
      const fail = async (code: string, message: string) => {
        await save({
          status: 'failed',
          errorCode: code,
          errorMessage: message,
          finishedAt: new Date(),
          wait: null,
        });
        await this.outbox.enqueue(tx, {
          tenantId,
          type: 'workflow.run.failed',
          payload: { runId, errorCode: code },
        });
        await this.system(tx, tenantId, 'workflow.run.failed', runId, { code });
      };

      // First, whatever the run was waiting for.
      if (run.wait?.kind === 'task') {
        const [task] = await tx.select().from(aiTasks).where(eq(aiTasks.id, run.wait.taskId));
        if (!task || TASK_OPEN.includes(task.status)) return;
        cost += Number(task.costUsd);
        await this.finishStep(
          tx,
          runId,
          task.status === 'completed' ? 'completed' : 'failed',
          task.result ?? task.progress ?? null,
          Number(task.costUsd),
        );
        if (task.status !== 'completed') {
          return fail(
            'WORKFLOW_STEP_FAILED',
            `Bước "${nodeOf(graph, run.currentNode!).label}" không xong: ${task.progress ?? task.errorCode ?? task.status}`,
          );
        }
        state.outputs[run.currentNode!] = (task.result ?? '').slice(0, OUTPUT_CHARS);
        run = await save({ wait: null, currentNode: following(graph, run.currentNode!) });
      } else if (run.wait?.kind === 'delay') {
        const due = new Date(run.wait.until).getTime();
        if (due > Date.now()) {
          after.push(() => this.enqueue({ tenantId, runId }, due - Date.now()));
          return;
        }
        await this.finishStep(tx, runId, 'completed', 'Đã chờ xong');
        run = await save({ wait: null, currentNode: following(graph, run.currentNode!) });
      } else if (run.wait?.kind === 'approval') {
        await save({ status: 'waiting_approval' });
        return;
      }

      for (;;) {
        const nodeId = run.currentNode;
        if (!nodeId) {
          await save({ status: 'completed', finishedAt: new Date(), currentNode: null });
          await this.outbox.enqueue(tx, {
            tenantId,
            type: 'workflow.run.completed',
            payload: { runId, costUsd: cost },
          });
          await this.system(tx, tenantId, 'workflow.run.completed', runId, {
            costUsd: cost,
            steps,
          });
          return;
        }
        if (steps >= graph.maxSteps) {
          return fail(
            'WORKFLOW_STEP_LIMIT',
            `Đã chạy ${steps} bước, chạm giới hạn ${graph.maxSteps} bước (có thể do vòng lặp)`,
          );
        }
        steps += 1;
        const node = nodeOf(graph, nodeId);
        let next = following(graph, node.id);
        try {
          switch (node.type) {
            case 'trigger':
              state.outputs[node.id] = JSON.stringify(state.input);
              await this.addStep(
                tx,
                tenantId,
                runId,
                node,
                'completed',
                null,
                state.outputs[node.id]!,
              );
              break;
            case 'condition': {
              const value = render(node.value, state);
              const ok = evaluate(node.operator, value, node.compare);
              state.outputs[node.id] = ok ? 'Đúng' : 'Sai';
              await this.addStep(
                tx,
                tenantId,
                runId,
                node,
                'completed',
                conditionText(node, value),
                state.outputs[node.id]!,
              );
              next = ok ? node.then : node.else;
              break;
            }
            case 'checkpoint':
              await this.addStep(tx, tenantId, runId, node, 'completed', null, 'Đã lưu');
              run = await save({ checkpoint: { nodeId: next, outputs: state.outputs } });
              break;
            case 'end':
              await this.addStep(tx, tenantId, runId, node, 'completed', null, null);
              next = null;
              break;
            case 'delay': {
              const until = new Date(Date.now() + node.seconds * 1000);
              await this.addStep(
                tx,
                tenantId,
                runId,
                node,
                'waiting',
                `Chờ ${node.seconds} giây`,
                null,
              );
              await save({
                currentNode: node.id,
                wait: { kind: 'delay', until: until.toISOString() },
              });
              after.push(() => this.enqueue({ tenantId, runId }, node.seconds * 1000));
              return;
            }
            case 'approval':
              await this.addStep(
                tx,
                tenantId,
                runId,
                node,
                'waiting',
                render(node.message, state),
                null,
              );
              await save({
                status: 'waiting_approval',
                currentNode: node.id,
                wait: { kind: 'approval' },
              });
              return;
            case 'ai':
            case 'skill': {
              const task = await this.createTask(tx, ctx, run, graph, node, state, cost);
              await this.addStep(
                tx,
                tenantId,
                runId,
                node,
                'waiting',
                task.input,
                null,
                task.row.id,
              );
              await save({ currentNode: node.id, wait: { kind: 'task', taskId: task.row.id } });
              after.push(() => this.tasks.start(tenantId, task.row.id, run.startedBy));
              return;
            }
          }
        } catch (err) {
          if (err instanceof StepError) {
            await this.addStep(tx, tenantId, runId, node, 'failed', null, err.message);
            return fail(err.code, err.message);
          }
          const e = err as { response?: { code?: string; message?: string } };
          if (e.response?.code) {
            await this.addStep(
              tx,
              tenantId,
              runId,
              node,
              'failed',
              null,
              e.response.message ?? e.response.code,
            );
            return fail(
              e.response.code,
              `Bước "${node.label}": ${e.response.message ?? e.response.code}`,
            );
          }
          throw err;
        }
        run = await save({ currentNode: next });
      }
    });
    for (const fn of after) await fn();
  }

  /** The task behind an AI or skill step, approved by the person who started the run. */
  private async createTask(
    tx: Tx,
    ctx: Ctx,
    run: RunRow,
    graph: WorkflowGraph,
    node: Extract<WorkflowNode, { type: 'ai' | 'skill' }>,
    state: RunState,
    spent: number,
  ): Promise<{ row: TaskRow; input: string }> {
    // The run budget is the ceiling: a step gets its own budget, cut down to what the run has left.
    const remaining = Math.floor((Number(run.budgetUsd) - spent) * 10_000) / 10_000;
    if (remaining < MIN_STEP_BUDGET_USD) throw budgetError(node.label, remaining);
    const capped = (budget: number) => Math.min(budget, remaining);
    let agentId: string | null = null;
    if (node.agentKey) {
      const [agent] = await tx
        .select()
        .from(aiAgents)
        .where(
          and(
            eq(aiAgents.tenantId, run.tenantId),
            eq(aiAgents.key, node.agentKey),
            isNull(aiAgents.deletedAt),
          ),
        );
      if (!agent)
        throw new StepError('WORKFLOW_REFERENCE_MISSING', `Không còn Agent "${node.agentKey}"`);
      if (agent.status !== 'active')
        throw new StepError('AI_AGENT_PAUSED', `${agent.name} đang tạm dừng`);
      agentId = agent.id;
    }
    const wf = await this.workflows.row(tx, run.tenantId, run.workflowId).catch(() => null);
    const origin = { runId: run.id, nodeId: node.id };
    if (node.type === 'ai') {
      const prompt = renderForAi(node.prompt, state);
      const row = await this.tasks.insert(tx, ctx, {
        title: `${wf?.name ?? 'Workflow'}: ${node.label}`.slice(0, 200),
        goal: `Bước "${node.label}" của Workflow "${wf?.name ?? ''}"`.slice(0, 4000),
        scope: 'Làm đúng hướng dẫn của bước; chỉ soạn văn bản.',
        successCriteria: 'Trả lời đúng yêu cầu của bước.',
        budgetUsd: capped(node.budgetUsd),
        agentId,
        requiredLevel: node.requiredLevel as TaskLevel,
        timeoutSec: node.timeoutSec,
        workflow: { ...origin, prompt },
        approvedBy: run.startedBy,
      });
      return { row, input: prompt };
    }
    const [skill] = await tx
      .select()
      .from(aiSkills)
      .where(
        and(
          eq(aiSkills.tenantId, run.tenantId),
          eq(aiSkills.key, node.skillKey),
          isNull(aiSkills.deletedAt),
        ),
      );
    if (!skill)
      throw new StepError('WORKFLOW_REFERENCE_MISSING', `Không còn Skill "${node.skillKey}"`);
    if (skill.status !== 'active')
      throw new StepError('SKILL_PAUSED', `Skill "${skill.name}" đang tắt`);
    const rendered = Object.fromEntries(
      Object.entries(node.inputs).map(([k, v]) => [k, render(v, state)]),
    );
    const inputs = checkInputs(skill.manifest.inputs, rendered);
    const body = skillTaskBody(skill, inputs, agentId, null);
    if (agentId) {
      const [agent] = await tx.select().from(aiAgents).where(eq(aiAgents.id, agentId));
      assertLevel(agent!, body.requiredLevel);
    }
    const row = await this.tasks.insert(tx, ctx, {
      ...body,
      budgetUsd: capped(body.budgetUsd),
      workflow: origin,
      approvedBy: run.startedBy,
    });
    return {
      row,
      input: Object.entries(inputs)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
    };
  }

  private async graph(tx: Tx, run: RunRow): Promise<WorkflowGraph> {
    return (await this.workflows.version(tx, run.workflowId, run.version)).graph as WorkflowGraph;
  }

  private async lock(tx: Tx, tenantId: string, runId: string): Promise<RunRow> {
    const [row] = await tx
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId)))
      .for('update');
    if (!row)
      throw new NotFoundException({
        code: 'WORKFLOW_RUN_NOT_FOUND',
        message: 'Không tìm thấy lần chạy',
      });
    return row;
  }

  private async setRun(tx: Tx, runId: string, patch: Partial<RunRow>): Promise<RunRow> {
    const [row] = await tx
      .update(workflowRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workflowRuns.id, runId))
      .returning();
    return row!;
  }

  private async addStep(
    tx: Tx,
    tenantId: string,
    runId: string,
    node: WorkflowNode,
    status: StepRow['status'],
    input: string | null,
    output: string | null,
    taskId: string | null = null,
  ): Promise<void> {
    const [last] = await tx
      .select({ seq: max(workflowRunSteps.seq) })
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.runId, runId));
    await tx.insert(workflowRunSteps).values({
      id: uuidv7(),
      tenantId,
      runId,
      seq: (last?.seq ?? 0) + 1,
      nodeId: node.id,
      nodeType: node.type,
      label: node.label,
      status,
      input: input?.slice(0, 40_000) ?? null,
      output: output?.slice(0, OUTPUT_CHARS) ?? null,
      taskId,
      finishedAt: status === 'completed' || status === 'failed' ? new Date() : null,
    });
  }

  /** Closes the step the run was waiting on. */
  private async finishStep(
    tx: Tx,
    runId: string,
    status: 'completed' | 'failed',
    output: string | null,
    costUsd = 0,
  ): Promise<void> {
    await tx
      .update(workflowRunSteps)
      .set({
        status,
        output: output?.slice(0, OUTPUT_CHARS) ?? null,
        costUsd: String(costUsd),
        finishedAt: new Date(),
      })
      .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.status, 'waiting')));
  }

  private async detail(
    tx: Tx,
    tenantId: string,
    runId: string,
  ): Promise<WorkflowRunDetailResponse> {
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.tenantId, tenantId)));
    if (!run)
      throw new NotFoundException({
        code: 'WORKFLOW_RUN_NOT_FOUND',
        message: 'Không tìm thấy lần chạy',
      });
    const steps = await tx
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.runId, runId))
      .orderBy(asc(workflowRunSteps.seq));
    return {
      ...runResponse(run),
      steps: steps.map((s) => ({
        seq: s.seq,
        nodeId: s.nodeId,
        nodeType: s.nodeType as WorkflowRunDetailResponse['steps'][number]['nodeType'],
        label: s.label,
        status: s.status,
        input: s.input,
        output: s.output,
        taskId: s.taskId,
        costUsd: Number(s.costUsd),
        startedAt: s.startedAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
      })),
    };
  }

  private async enqueue(job: WorkflowJob, delayMs = 0): Promise<void> {
    if (!this.queue) {
      const connection = this.redis.duplicate();
      this.connections.push(connection);
      this.queue = new Queue(WORKFLOWS_QUEUE, { connection });
    }
    await this.queue.add('advance', job, {
      delay: Math.max(0, delayMs),
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }

  private log(tx: Tx, ctx: Ctx, action: string, id: string, metadata?: Record<string, unknown>) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'workflow_run',
      targetId: id,
      metadata,
      ip: ctx.ip,
    });
  }

  private system(
    tx: Tx,
    tenantId: string,
    action: string,
    id: string,
    metadata?: Record<string, unknown>,
  ) {
    return this.audit.append(tx, {
      tenantId,
      actorUserId: null,
      action,
      targetType: 'workflow_run',
      targetId: id,
      metadata,
    });
  }
}

/** Below this a step cannot do useful AI work, so the run stops instead. */
const MIN_STEP_BUDGET_USD = 0.01;

function budgetError(label: string, remaining: number): StepError {
  return new StepError(
    'WORKFLOW_BUDGET_EXCEEDED',
    `Hết ngân sách trước bước "${label}": lần chạy chỉ còn $${Math.max(0, remaining).toFixed(4)}, mỗi bước AI cần ít nhất $${MIN_STEP_BUDGET_USD}`,
  );
}

function forbidden(): ForbiddenException {
  return new ForbiddenException({
    code: 'FORBIDDEN',
    message: 'Chỉ người bắt đầu lần chạy hoặc người có quyền duyệt mới làm được',
  });
}

function expectStatus(run: RunRow, allowed: RunRow['status'][]): void {
  if (!allowed.includes(run.status)) {
    throw new BadRequestException({
      code: 'WORKFLOW_RUN_WRONG_STATUS',
      message: `Lần chạy đang ở trạng thái "${run.status}", không làm được thao tác này`,
    });
  }
}

export function runResponse(r: RunRow): WorkflowRunResponse {
  return {
    id: r.id,
    workflowId: r.workflowId,
    version: r.version,
    status: r.status,
    input: r.input,
    currentNode: r.currentNode,
    waitingFor: r.wait?.kind ?? null,
    budgetUsd: Number(r.budgetUsd),
    costUsd: Number(r.costUsd),
    stepsTaken: r.stepsTaken,
    hasCheckpoint: !!r.checkpoint,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    startedBy: r.startedBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}
