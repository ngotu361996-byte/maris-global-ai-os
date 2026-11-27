import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import type { ConnectorWebhook, WorkflowNode } from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import { clientIp } from '../common/request-context';
import { tokenHash } from '../connectors/connectors.service';
import { DbService, type Tx } from '../db/db.service';
import { RateLimit } from '../ratelimit/rate-limit.guard';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsService } from './workflows.service';

const { connectors, webhookEvents, tenantMembers, rolePermissions } = schema;

type EventStatus = 'accepted' | 'rejected' | 'started';
interface Outcome {
  status: EventStatus;
  detail: string;
  httpStatus: number;
  start?: {
    userId: string;
    workflowId: string;
    inputs: Record<string, string | number>;
    budgetUsd: number;
  };
}

/**
 * Receives calls on webhook connectors. The sender proves itself with the connector's token in the
 * X-Maris-Token header (only its hash is stored). An accepted call can start the connector's
 * workflow, on behalf of the person who activated the connector, who must still hold ai.approve.
 * The body is data: only fields named like the workflow's inputs are taken from it.
 */
@Injectable()
export class WebhookIntakeService {
  constructor(
    private readonly db: DbService,
    private readonly workflows: WorkflowsService,
    private readonly runs: WorkflowRunsService,
    private readonly audit: AuditService,
  ) {}

  async receive(
    tenantId: string,
    connectorId: string,
    token: string | undefined,
    body: unknown,
    ip: string | null,
  ): Promise<{ eventId: string; status: EventStatus; workflowRunId: string | null }> {
    const excerpt = excerptOf(body);
    const outcome = await this.db.withContext({ tenantId }, async (tx) => {
      const [row] = await tx
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.id, connectorId),
            eq(connectors.tenantId, tenantId),
            eq(connectors.kind, 'webhook'),
            isNull(connectors.deletedAt),
          ),
        );
      if (!row) return null;
      const check = await this.check(tx, row, token, body);
      return { row, check };
    });
    if (!outcome) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Không tìm thấy' });

    const { row, check } = outcome;
    let status = check.status;
    let detail = check.detail;
    let httpStatus = check.httpStatus;
    let runId: string | null = null;
    if (check.start) {
      try {
        const run = await this.runs.start(
          { tenantId, userId: check.start.userId, ip },
          check.start.workflowId,
          { inputs: check.start.inputs, budgetUsd: check.start.budgetUsd },
        );
        runId = run.id;
        status = 'started';
        detail = `Đã chạy Workflow (lần chạy ${run.id.slice(0, 8)})`;
      } catch (e) {
        const r = (e as { response?: { message?: string } }).response;
        status = 'rejected';
        detail = `Không chạy được Workflow: ${r?.message ?? 'lỗi không rõ'}`;
        httpStatus = e instanceof HttpException ? e.getStatus() : 500;
      }
    }
    const eventId = uuidv7();
    await this.db.withContext({ tenantId }, async (tx) => {
      await tx.insert(webhookEvents).values({
        id: eventId,
        tenantId,
        connectorId: row.id,
        status,
        detail: detail.slice(0, 500),
        bodyExcerpt: status === 'rejected' && httpStatus === 401 ? '' : excerpt,
        workflowRunId: runId,
      });
      if (status !== 'rejected' || httpStatus !== 401) {
        await this.audit.append(tx, {
          tenantId,
          actorUserId: row.activatedBy,
          action: 'connector.webhook_received',
          targetType: 'connector',
          targetId: row.id,
          metadata: { eventId, status, workflowRunId: runId },
          ip,
        });
      }
    });
    if (httpStatus >= 400) {
      const payload = { code: codeFor(httpStatus), message: detail };
      if (httpStatus === 401) throw new UnauthorizedException(payload);
      if (httpStatus === 403) throw new ForbiddenException(payload);
      throw new HttpException(payload, httpStatus);
    }
    return { eventId, status, workflowRunId: runId };
  }

  private async check(
    tx: Tx,
    row: typeof connectors.$inferSelect,
    token: string | undefined,
    body: unknown,
  ): Promise<Outcome> {
    const reject = (httpStatus: number, detail: string): Outcome => ({
      status: 'rejected',
      detail,
      httpStatus,
    });
    if (!row.webhookTokenHash || !token || !sameHash(tokenHash(token), row.webhookTokenHash))
      return reject(401, 'Sai hoặc thiếu mã bí mật (X-Maris-Token)');
    if (row.status !== 'active') return reject(409, 'Connector chưa bật');
    const hook = row.webhook as ConnectorWebhook | null;
    if (!hook?.workflowKey) return { status: 'accepted', detail: 'Đã nhận', httpStatus: 202 };

    if (!row.activatedBy || !(await this.canApprove(tx, row.tenantId, row.activatedBy)))
      return reject(403, 'Người bật Connector không còn quyền ai.approve; cần người khác bật lại');
    const wf = await this.workflows.findByKey(tx, row.tenantId, hook.workflowKey);
    if (!wf) return reject(409, `Không có Workflow "${hook.workflowKey}"`);
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      return reject(400, 'Nội dung phải là một đối tượng JSON');
    const trigger = wf.graph.nodes[0] as Extract<WorkflowNode, { type: 'trigger' }>;
    const inputs: Record<string, string | number> = {};
    for (const f of trigger.inputs) {
      const v = (body as Record<string, unknown>)[f.name];
      if (typeof v === 'string' || typeof v === 'number') inputs[f.name] = v;
    }
    return {
      status: 'accepted',
      detail: 'Đã nhận',
      httpStatus: 202,
      start: { userId: row.activatedBy, workflowId: wf.id, inputs, budgetUsd: hook.runBudgetUsd },
    };
  }

  private async canApprove(tx: Tx, tenantId: string, userId: string): Promise<boolean> {
    const [hit] = await tx
      .select({ key: rolePermissions.permissionKey })
      .from(tenantMembers)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, tenantMembers.roleId))
      .where(
        and(
          eq(tenantMembers.tenantId, tenantId),
          eq(tenantMembers.userId, userId),
          eq(rolePermissions.permissionKey, 'ai.approve'),
        ),
      )
      .limit(1);
    return !!hit;
  }
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

function excerptOf(body: unknown): string {
  try {
    const text = JSON.stringify(body) ?? '';
    return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
  } catch {
    return '';
  }
}

function codeFor(status: number): string {
  if (status === 401) return 'WEBHOOK_TOKEN_INVALID';
  if (status === 403) return 'WEBHOOK_NOT_ALLOWED';
  if (status === 409) return 'WEBHOOK_NOT_READY';
  return 'WEBHOOK_REJECTED';
}

/** Public endpoint for webhook senders (n8n, Make, websites). No session: the token is the key. */
@Controller('hooks')
export class WebhookIntakeController {
  constructor(private readonly intake: WebhookIntakeService) {}

  @Post(':tenantId/:connectorId')
  @HttpCode(HttpStatus.ACCEPTED)
  @RateLimit({ name: 'hook', limit: 60, windowSec: 60, by: 'ip' })
  receive(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('connectorId', new ParseUUIDPipe()) connectorId: string,
    @Headers('x-maris-token') token: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    return this.intake.receive(tenantId, connectorId, token, body, clientIp(req));
  }
}
