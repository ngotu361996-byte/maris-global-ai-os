import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  canonicalJson,
  CONNECTOR_FORMAT,
  CONNECTOR_TEMPLATES,
  connectorManifestSchema,
  createConnectorSchema,
  type CallConnector,
  type ConnectorAuth,
  type ConnectorCallResponse,
  type ConnectorCapability,
  type ConnectorManifest,
  type ConnectorResponse,
  type ConnectorTokenResponse,
  type ConnectorWebhook,
  type CreateConnector,
  type ImportConnector,
  type UpdateConnector,
  type WebhookEventResponse,
} from '@maris/contracts';
import { checkInputs } from '../ai/skills.service';
import type { Ctx } from '../ai/chat.service';
import { ControlService } from '../ai/control.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { SecretVaultService } from '../secrets/secret-vault.service';
import { assertConnectorUrl, connectorRequest, ConnectorHttpError } from './connector-http';
import { buildRequest, extractOutput, redact, RequestBuildError } from './connector-request';

const { connectors, connectorCalls, webhookEvents, secrets } = schema;
export type ConnectorRow = typeof connectors.$inferSelect;
type CallRow = typeof connectorCalls.$inferSelect;

/** Parts of a connector that decide where and how it calls: changing one sends it back to draft. */
const REVIEWED = ['baseUrl', 'auth', 'headers', 'capabilities', 'webhook'] as const;

/**
 * Connector Hub (spec Part 24). A connector declares an external API and what may be done with it
 * (its capability registry); secrets are referenced by Secret Vault name and only resolved for the
 * moment of a call. New, imported and edited connectors are drafts until someone with ai.approve
 * activates them. Every call is logged with its secrets masked, and what comes back is data: it is
 * fenced before any AI reads it and never treated as an instruction.
 */
@Injectable()
export class ConnectorsService {
  constructor(
    private readonly db: DbService,
    private readonly vault: SecretVaultService,
    private readonly audit: AuditService,
    private readonly control: ControlService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  list(ctx: Ctx): Promise<ConnectorResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(connectors)
        .where(and(eq(connectors.tenantId, ctx.tenantId), isNull(connectors.deletedAt)))
        .orderBy(asc(connectors.name));
      const have = await this.secretNames(tx, ctx.tenantId);
      return rows.map((r) => response(r, have));
    });
  }

  get(ctx: Ctx, id: string): Promise<ConnectorResponse> {
    return this.db.withContext(ctx, async (tx) =>
      this.respond(tx, await this.row(tx, ctx.tenantId, id)),
    );
  }

  create(ctx: Ctx, body: CreateConnector): Promise<ConnectorResponse> {
    const parsed = createConnectorSchema.parse(body);
    return this.db.withContext(ctx, async (tx) => {
      await this.assertKeyFree(tx, ctx.tenantId, parsed.key);
      const row = await this.insert(tx, ctx, { ...parsed, source: 'created' });
      await this.log(tx, ctx, 'connector.created', row.id, { key: row.key, kind: row.kind });
      return this.respond(tx, row);
    });
  }

  /** Installs the starter connectors as drafts. Keys already taken are skipped. */
  installTemplates(ctx: Ctx): Promise<ConnectorResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const taken = new Set((await this.rows(tx, ctx.tenantId)).map((r) => r.key));
      const created: ConnectorRow[] = [];
      for (const t of CONNECTOR_TEMPLATES) {
        if (taken.has(t.key)) continue;
        const parsed = createConnectorSchema.parse({ ...t, timeoutSec: 15 });
        created.push(await this.insert(tx, ctx, { ...parsed, source: 'template' }));
      }
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'connector.templates_installed',
        targetType: 'connector',
        metadata: { keys: created.map((r) => r.key) },
        ip: ctx.ip,
      });
      const have = await this.secretNames(tx, ctx.tenantId);
      return created.map((r) => response(r, have));
    });
  }

  update(ctx: Ctx, id: string, body: UpdateConnector): Promise<ConnectorResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      const merged = createConnectorSchema.safeParse({
        key: current.key,
        kind: current.kind,
        ...manifestBody(current),
        ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
      });
      if (!merged.success) {
        throw new BadRequestException({
          code: 'VALIDATION',
          message: merged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
      }
      const next = merged.data;
      const reviewedChanged = REVIEWED.some(
        (k) => canonicalJson(next[k]) !== canonicalJson(manifestBody(current)[k]),
      );
      const backToDraft = reviewedChanged && current.status !== 'draft';
      const [row] = await tx
        .update(connectors)
        .set({
          name: next.name,
          description: next.description,
          baseUrl: next.baseUrl,
          auth: next.auth,
          headers: next.headers,
          timeoutSec: next.timeoutSec,
          capabilities: next.capabilities,
          webhook: next.webhook,
          checksum: checksumOf({ ...next, key: current.key, kind: current.kind }),
          updatedAt: new Date(),
          ...(backToDraft
            ? { status: 'draft' as const, activatedBy: null, activatedAt: null }
            : {}),
        })
        .where(eq(connectors.id, id))
        .returning();
      await this.log(tx, ctx, 'connector.updated', id, {
        fields: Object.keys(body),
        backToDraft,
      });
      return this.respond(tx, row!);
    });
  }

  /** Turning a connector on approves its calls; it needs ai.approve and every secret it uses. */
  activate(ctx: Ctx, id: string): Promise<ConnectorResponse> {
    return this.db.withContext(ctx, async (tx) => this.respond(tx, await this.activateIn(tx, ctx, id)));
  }

  /** Activation inside a caller's transaction; plugin activation turns its connectors on with it. */
  async activateIn(tx: Tx, ctx: Ctx, id: string): Promise<ConnectorRow> {
    {
      const current = await this.row(tx, ctx.tenantId, id);
      const missing = missingSecrets(current, await this.secretNames(tx, ctx.tenantId));
      if (missing.length) {
        throw new BadRequestException({
          code: 'CONNECTOR_SECRET_MISSING',
          message: `Chưa có secret trong Secret Vault: ${missing.join(', ')}`,
        });
      }
      if (current.kind === 'http') this.checkUrl(current.baseUrl!);
      if (current.kind === 'webhook' && !current.webhookTokenHash) {
        throw new BadRequestException({
          code: 'CONNECTOR_TOKEN_MISSING',
          message: 'Tạo mã bí mật cho Webhook trước khi bật',
        });
      }
      const [row] = await tx
        .update(connectors)
        .set({
          status: 'active',
          activatedBy: ctx.userId,
          activatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(connectors.id, id))
        .returning();
      await this.log(tx, ctx, 'connector.activated', id, {
        key: row!.key,
        checksum: row!.checksum,
      });
      return row!;
    }
  }

  pause(ctx: Ctx, id: string): Promise<ConnectorResponse> {
    return this.db.withContext(ctx, async (tx) => this.respond(tx, await this.pauseIn(tx, ctx, id)));
  }

  async pauseIn(tx: Tx, ctx: Ctx, id: string): Promise<ConnectorRow> {
    {
      const current = await this.row(tx, ctx.tenantId, id);
      if (current.status !== 'active') return current;
      const [row] = await tx
        .update(connectors)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(eq(connectors.id, id))
        .returning();
      await this.log(tx, ctx, 'connector.paused', id, { key: row!.key });
      return row!;
    }
  }

  remove(ctx: Ctx, id: string): Promise<void> {
    return this.db.withContext(ctx, (tx) => this.removeIn(tx, ctx, id));
  }

  async removeIn(tx: Tx, ctx: Ctx, id: string): Promise<void> {
    {
      const current = await this.row(tx, ctx.tenantId, id);
      await tx
        .update(connectors)
        .set({ deletedAt: new Date(), status: 'paused', webhookTokenHash: null })
        .where(eq(connectors.id, id));
      await this.log(tx, ctx, 'connector.deleted', id, { key: current.key });
    }
  }

  /** A new webhook token, shown once. The old one stops working at once. */
  rotateToken(ctx: Ctx, id: string): Promise<ConnectorTokenResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      if (current.kind !== 'webhook') {
        throw new BadRequestException({
          code: 'CONNECTOR_NOT_WEBHOOK',
          message: 'Chỉ Connector nhận Webhook mới có mã bí mật',
        });
      }
      const token = randomBytes(32).toString('base64url');
      const [row] = await tx
        .update(connectors)
        .set({ webhookTokenHash: tokenHash(token), updatedAt: new Date() })
        .where(eq(connectors.id, id))
        .returning();
      await this.log(tx, ctx, 'connector.webhook_token_rotated', id, { key: current.key });
      return { connector: await this.respond(tx, row!), token };
    });
  }

  export(ctx: Ctx, id: string): Promise<ConnectorManifest> {
    return this.db.withContext(ctx, async (tx) => {
      const row = await this.row(tx, ctx.tenantId, id);
      await this.log(tx, ctx, 'connector.exported', id, { key: row.key });
      return {
        format: CONNECTOR_FORMAT,
        key: row.key,
        kind: row.kind,
        ...manifestBody(row),
        checksum: row.checksum,
      };
    });
  }

  /** Imports arrive as drafts: someone reads them and activates them before they call anything. */
  import(ctx: Ctx, body: ImportConnector): Promise<ConnectorResponse> {
    return this.db.withContext(ctx, async (tx) =>
      this.respond(tx, await this.importIn(tx, ctx, body.manifest, body.replace ?? false)),
    );
  }

  /** The import inside a caller's transaction; plugins install their connectors with it. */
  async importIn(tx: Tx, ctx: Ctx, manifest: unknown, replace: boolean): Promise<ConnectorRow> {
    const parsed = connectorManifestSchema.safeParse(manifest);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'CONNECTOR_INVALID',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const m = parsed.data;
    if (m.checksum && m.checksum !== checksumOf(m)) {
      throw new BadRequestException({
        code: 'CONNECTOR_CHECKSUM_MISMATCH',
        message: 'Tệp đã bị sửa sau khi xuất (checksum không khớp)',
      });
    }
    {
      const [existing] = await tx
        .select()
        .from(connectors)
        .where(
          and(
            eq(connectors.tenantId, ctx.tenantId),
            eq(connectors.key, m.key),
            isNull(connectors.deletedAt),
          ),
        );
      if (existing && !replace) {
        throw new ConflictException({
          code: 'CONNECTOR_EXISTS',
          message: `Đã có Connector mã "${m.key}". Chọn thay thế nếu muốn ghi đè.`,
        });
      }
      if (existing) {
        await tx
          .update(connectors)
          .set({ deletedAt: new Date(), status: 'paused', webhookTokenHash: null })
          .where(eq(connectors.id, existing.id));
      }
      const row = await this.insert(tx, ctx, { ...m, source: 'imported' });
      await this.log(tx, ctx, 'connector.imported', row.id, { key: row.key, replaced: !!existing });
      return row;
    }
  }

  /** Secret names a connector uses that are not in the Secret Vault. */
  async missingSecretsOf(tx: Tx, row: ConnectorRow): Promise<string[]> {
    return missingSecrets(row, await this.secretNames(tx, row.tenantId));
  }

  /**
   * A call made by a person from the Connector page, to try a capability. Drafts can be tried, so a
   * connector can be checked before it is activated. Write capabilities need ai.approve.
   */
  async call(
    ctx: Ctx,
    id: string,
    body: CallConnector,
    canApprove: boolean,
  ): Promise<ConnectorCallResponse> {
    const callId = await this.db.withContext(ctx, async (tx) => {
      await this.control.assertRunning(tx, ctx.tenantId);
      const row = await this.row(tx, ctx.tenantId, id);
      if (row.status === 'paused') {
        throw new BadRequestException({
          code: 'CONNECTOR_PAUSED',
          message: `Connector "${row.name}" đang tạm tắt`,
        });
      }
      const cap = this.capability(row, body.capability);
      if (cap.risk === 'write' && !canApprove) {
        throw new ForbiddenException({
          code: 'PERMISSION_DENIED',
          message: 'Thao tác gửi ra ngoài cần quyền ai.approve',
        });
      }
      return this.prepare(tx, ctx.tenantId, ctx.userId, row, cap, body.inputs ?? {}, null);
    });
    await this.execute(ctx.tenantId, callId);
    return this.db.withContext(ctx, async (tx) => callResponse(await this.callRow(tx, callId)));
  }

  /**
   * A call for a workflow step: the connector must be active. Returns the logged call; execute()
   * makes the request after the caller's transaction commits.
   */
  async prepareForRun(
    tx: Tx,
    tenantId: string,
    userId: string,
    connectorKey: string,
    capability: string,
    inputs: Record<string, string | number>,
    runId: string,
  ): Promise<{ callId: string; request: string }> {
    const [row] = await tx
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.tenantId, tenantId),
          eq(connectors.key, connectorKey),
          isNull(connectors.deletedAt),
        ),
      );
    if (!row)
      throw new StepFailure('WORKFLOW_REFERENCE_MISSING', `Không còn Connector "${connectorKey}"`);
    if (row.kind !== 'http')
      throw new StepFailure('WORKFLOW_REFERENCE_MISSING', `"${row.name}" không gọi ra ngoài`);
    if (row.status !== 'active') {
      throw new StepFailure(
        'CONNECTOR_NOT_ACTIVE',
        `Connector "${row.name}" ${row.status === 'draft' ? 'chưa được kích hoạt' : 'đang tạm tắt'}`,
      );
    }
    const cap = row.capabilities.find((c) => c.key === capability);
    if (!cap)
      throw new StepFailure(
        'WORKFLOW_REFERENCE_MISSING',
        `"${row.name}" không có thao tác "${capability}"`,
      );
    let checked: Record<string, string | number>;
    try {
      checked = checkInputs(cap.inputs, inputs);
    } catch (e) {
      throw new StepFailure(
        'CONNECTOR_INPUT_INVALID',
        (e as { response?: { message?: string } }).response?.message ?? 'Ô nhập không hợp lệ',
      );
    }
    const callId = await this.prepare(
      tx,
      tenantId,
      userId,
      row,
      cap as ConnectorCapability,
      checked,
      runId,
    );
    const [call] = await tx.select().from(connectorCalls).where(eq(connectorCalls.id, callId));
    return { callId, request: call!.request };
  }

  /**
   * Makes the request of a pending call, outside any transaction, and records the result. Never
   * throws: a failure is written to the call.
   */
  async execute(tenantId: string, callId: string): Promise<void> {
    let secret: string | null = null;
    const started = Date.now();
    const finish = (patch: Partial<CallRow>) =>
      this.db.withContext({ tenantId }, async (tx) => {
        const [row] = await tx
          .update(connectorCalls)
          .set({ ...patch, durationMs: Date.now() - started, finishedAt: new Date() })
          .where(and(eq(connectorCalls.id, callId), eq(connectorCalls.status, 'pending')))
          .returning();
        if (!row) return;
        await this.audit.append(tx, {
          tenantId,
          actorUserId: row.calledBy,
          action: row.status === 'ok' ? 'connector.called' : 'connector.call_failed',
          targetType: 'connector',
          targetId: row.connectorId,
          metadata: {
            callId,
            capability: row.capability,
            risk: row.risk,
            httpStatus: row.httpStatus,
            errorCode: row.errorCode,
            workflowRunId: row.workflowRunId,
          },
          ip: null,
        });
      });
    try {
      const prepared = await this.db.withContext({ tenantId }, async (tx) => {
        const call = await this.callRow(tx, callId);
        if (call.status !== 'pending') return null;
        const [row] = await tx.select().from(connectors).where(eq(connectors.id, call.connectorId));
        const cap = row!.capabilities.find((c) => c.key === call.capability)!;
        const auth = row!.auth as ConnectorAuth;
        secret =
          auth.type === 'none' ? null : await this.vault.resolveByName(tx, tenantId, auth.secret);
        const inputs = this.pendingInputs.get(callId);
        if (!inputs) {
          await this.abandon(tx, callId);
          return null;
        }
        return { row: row!, cap: cap as ConnectorCapability, inputs };
      });
      if (!prepared) return;
      const req = buildRequest(
        {
          baseUrl: prepared.row.baseUrl!,
          auth: prepared.row.auth as ConnectorAuth,
          headers: prepared.row.headers,
        },
        prepared.cap,
        prepared.inputs,
        secret,
      );
      const res = await connectorRequest({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        timeoutMs: prepared.row.timeoutSec * 1000,
        allowPrivate: this.config.CONNECTOR_ALLOW_PRIVATE_URLS,
      });
      const text = redact(res.body, secret);
      if (res.status < 200 || res.status >= 300) {
        await finish({
          status: 'failed',
          httpStatus: res.status,
          output: text.slice(0, 4000),
          errorCode: 'CONNECTOR_HTTP_ERROR',
          errorMessage: `Bên kia trả lỗi HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (chuyển hướng, MARIS không đi theo)' : ''}`,
        });
        return;
      }
      if (res.truncated) {
        await finish({
          status: 'failed',
          httpStatus: res.status,
          errorCode: 'CONNECTOR_RESPONSE_TOO_LARGE',
          errorMessage: 'Kết quả quá lớn (trên 256 KB)',
        });
        return;
      }
      await finish({
        status: 'ok',
        httpStatus: res.status,
        output: extractOutput(text, prepared.cap.outputPath),
      });
    } catch (e) {
      const known = e instanceof ConnectorHttpError || e instanceof RequestBuildError;
      const code = known
        ? e.code
        : ((e as { response?: { code?: string } }).response?.code ?? 'CONNECTOR_ERROR');
      const message = redact(
        known
          ? e.message
          : ((e as { response?: { message?: string } }).response?.message ??
              'Lỗi khi gọi Connector'),
        secret,
      );
      await finish({
        status: 'failed',
        errorCode: code,
        errorMessage: message.slice(0, 1000),
      }).catch(() => undefined);
    } finally {
      this.pendingInputs.delete(callId);
    }
  }

  /** True while this process is making the call. */
  isInFlight(callId: string): boolean {
    return this.pendingInputs.has(callId);
  }

  callRow(tx: Tx, callId: string): Promise<CallRow> {
    return tx
      .select()
      .from(connectorCalls)
      .where(eq(connectorCalls.id, callId))
      .then(([r]) => {
        if (!r)
          throw new NotFoundException({
            code: 'CONNECTOR_CALL_NOT_FOUND',
            message: 'Không tìm thấy lần gọi',
          });
        return r;
      });
  }

  /** Marks a call that never finished (the API stopped mid-call) as failed. */
  async abandon(tx: Tx, callId: string): Promise<void> {
    await tx
      .update(connectorCalls)
      .set({
        status: 'failed',
        errorCode: 'CONNECTOR_INTERRUPTED',
        errorMessage:
          'Lần gọi bị ngắt giữa chừng (API đã dừng); không biết bên kia đã nhận hay chưa',
        finishedAt: new Date(),
      })
      .where(and(eq(connectorCalls.id, callId), eq(connectorCalls.status, 'pending')));
  }

  calls(ctx: Ctx, id: string): Promise<ConnectorCallResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.row(tx, ctx.tenantId, id);
      const rows = await tx
        .select()
        .from(connectorCalls)
        .where(and(eq(connectorCalls.tenantId, ctx.tenantId), eq(connectorCalls.connectorId, id)))
        .orderBy(desc(connectorCalls.createdAt))
        .limit(50);
      return rows.map(callResponse);
    });
  }

  events(ctx: Ctx, id: string): Promise<WebhookEventResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.row(tx, ctx.tenantId, id);
      const rows = await tx
        .select()
        .from(webhookEvents)
        .where(and(eq(webhookEvents.tenantId, ctx.tenantId), eq(webhookEvents.connectorId, id)))
        .orderBy(desc(webhookEvents.receivedAt))
        .limit(50);
      return rows.map(eventResponse);
    });
  }

  /** Active connectors by key, for checking workflow references. */
  async byKey(tx: Tx, tenantId: string, key: string): Promise<ConnectorRow | undefined> {
    const [row] = await tx
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.tenantId, tenantId),
          eq(connectors.key, key),
          isNull(connectors.deletedAt),
        ),
      );
    return row;
  }

  async row(tx: Tx, tenantId: string, id: string): Promise<ConnectorRow> {
    const [row] = await tx
      .select()
      .from(connectors)
      .where(
        and(eq(connectors.id, id), eq(connectors.tenantId, tenantId), isNull(connectors.deletedAt)),
      );
    if (!row)
      throw new NotFoundException({
        code: 'CONNECTOR_NOT_FOUND',
        message: 'Không tìm thấy Connector',
      });
    return row;
  }

  // ---------- internals ----------

  /**
   * Inputs of calls waiting to be made. They stay in memory, not in the call log, because they may
   * hold personal data; the log keeps the masked address only. A call whose inputs are gone (the
   * API restarted) fails as interrupted.
   */
  private readonly pendingInputs = new Map<string, Record<string, string | number>>();

  private async prepare(
    tx: Tx,
    tenantId: string,
    userId: string,
    row: ConnectorRow,
    cap: ConnectorCapability,
    given: Record<string, string | number>,
    runId: string | null,
  ): Promise<string> {
    const inputs = checkInputs(cap.inputs, given);
    // Build once without the secret to fail early on bad inputs and to get the masked summary.
    let summary: string;
    try {
      summary = buildRequest(
        { baseUrl: row.baseUrl!, auth: row.auth as ConnectorAuth, headers: row.headers },
        cap,
        inputs,
        row.auth.type === 'none' ? null : 'x-secret-placeholder',
      ).summary;
    } catch (e) {
      if (e instanceof RequestBuildError)
        throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
    const id = uuidv7();
    await tx.insert(connectorCalls).values({
      id,
      tenantId,
      connectorId: row.id,
      capability: cap.key,
      risk: cap.risk,
      status: 'pending',
      request: summary,
      workflowRunId: runId,
      calledBy: userId,
    });
    this.pendingInputs.set(id, inputs);
    return id;
  }

  private capability(row: ConnectorRow, key: string): ConnectorCapability {
    if (row.kind !== 'http') {
      throw new BadRequestException({
        code: 'CONNECTOR_NOT_HTTP',
        message: 'Connector nhận Webhook không gọi ra ngoài',
      });
    }
    const cap = row.capabilities.find((c) => c.key === key);
    if (!cap)
      throw new NotFoundException({
        code: 'CONNECTOR_CAPABILITY_NOT_FOUND',
        message: `Không có thao tác "${key}"`,
      });
    return cap as ConnectorCapability;
  }

  private checkUrl(raw: string) {
    try {
      assertConnectorUrl(new URL(raw), this.config.CONNECTOR_ALLOW_PRIVATE_URLS);
    } catch (e) {
      if (e instanceof ConnectorHttpError)
        throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
  }

  private async insert(
    tx: Tx,
    ctx: Ctx,
    data: Omit<ConnectorManifest, 'format' | 'checksum'> & { source: ConnectorRow['source'] },
  ): Promise<ConnectorRow> {
    const [row] = await tx
      .insert(connectors)
      .values({
        id: uuidv7(),
        tenantId: ctx.tenantId,
        key: data.key,
        name: data.name,
        description: data.description,
        kind: data.kind,
        source: data.source,
        status: 'draft',
        baseUrl: data.baseUrl,
        auth: data.auth,
        headers: data.headers,
        timeoutSec: data.timeoutSec,
        capabilities: data.capabilities,
        webhook: data.webhook,
        checksum: checksumOf(data),
        createdBy: ctx.userId,
      })
      .returning();
    return row!;
  }

  private async assertKeyFree(tx: Tx, tenantId: string, key: string) {
    const [taken] = await tx
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.tenantId, tenantId),
          eq(connectors.key, key),
          isNull(connectors.deletedAt),
        ),
      );
    if (taken)
      throw new ConflictException({
        code: 'CONNECTOR_EXISTS',
        message: `Đã có Connector mã "${key}"`,
      });
  }

  private rows(tx: Tx, tenantId: string) {
    return tx
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenantId, tenantId), isNull(connectors.deletedAt)));
  }

  private async secretNames(tx: Tx, tenantId: string): Promise<Set<string>> {
    const rows = await tx
      .select({ name: secrets.name })
      .from(secrets)
      .where(and(eq(secrets.tenantId, tenantId), isNull(secrets.deletedAt)));
    return new Set(rows.map((r) => r.name));
  }

  private async respond(tx: Tx, row: ConnectorRow): Promise<ConnectorResponse> {
    return response(row, await this.secretNames(tx, row.tenantId));
  }

  private log(tx: Tx, ctx: Ctx, action: string, id: string, metadata?: Record<string, unknown>) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'connector',
      targetId: id,
      metadata,
      ip: ctx.ip,
    });
  }
}

/** A workflow step that cannot go on; the run engine turns it into a failed run. */
export class StepFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function manifestBody(r: ConnectorRow) {
  return {
    name: r.name,
    description: r.description,
    baseUrl: r.baseUrl,
    auth: r.auth as ConnectorAuth,
    headers: r.headers,
    timeoutSec: r.timeoutSec,
    capabilities: r.capabilities as ConnectorCapability[],
    webhook: r.webhook as ConnectorWebhook | null,
  };
}

function checksumOf(
  m: Omit<ConnectorManifest, 'format' | 'checksum'> & { checksum?: string },
): string {
  const body = {
    format: CONNECTOR_FORMAT,
    key: m.key,
    kind: m.kind,
    name: m.name,
    description: m.description,
    baseUrl: m.baseUrl,
    auth: m.auth,
    headers: m.headers,
    timeoutSec: m.timeoutSec,
    capabilities: m.capabilities,
    webhook: m.webhook,
  };
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function missingSecrets(r: ConnectorRow, have: Set<string>): string[] {
  const auth = r.auth as ConnectorAuth;
  return auth.type !== 'none' && !have.has(auth.secret) ? [auth.secret] : [];
}

export function webhookPath(r: Pick<ConnectorRow, 'tenantId' | 'id'>): string {
  return `/hooks/${r.tenantId}/${r.id}`;
}

function response(r: ConnectorRow, have: Set<string>): ConnectorResponse {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    kind: r.kind,
    source: r.source,
    status: r.status,
    baseUrl: r.baseUrl,
    auth: r.auth as ConnectorAuth,
    headers: r.headers,
    timeoutSec: r.timeoutSec,
    capabilities: r.capabilities as ConnectorCapability[],
    webhook: r.webhook
      ? { ...(r.webhook as ConnectorWebhook), path: webhookPath(r), hasToken: !!r.webhookTokenHash }
      : null,
    missingSecrets: missingSecrets(r, have),
    activatedBy: r.activatedBy,
    activatedAt: r.activatedAt?.toISOString() ?? null,
    checksum: r.checksum,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function callResponse(r: CallRow): ConnectorCallResponse {
  return {
    id: r.id,
    connectorId: r.connectorId,
    capability: r.capability,
    risk: r.risk,
    status: r.status,
    request: r.request,
    httpStatus: r.httpStatus,
    durationMs: r.durationMs,
    output: r.output,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    workflowRunId: r.workflowRunId,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

export function eventResponse(r: typeof webhookEvents.$inferSelect): WebhookEventResponse {
  return {
    id: r.id,
    connectorId: r.connectorId,
    status: r.status,
    detail: r.detail,
    bodyExcerpt: r.bodyExcerpt,
    workflowRunId: r.workflowRunId,
    receivedAt: r.receivedAt.toISOString(),
  };
}
