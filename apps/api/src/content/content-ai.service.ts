import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  CONTENT_AI_LIMITS,
  CONTENT_LIMITS,
  LANGUAGES,
  createItemSchema,
  generateSchema,
  variantSchema,
  type Generate,
  type ItemDetailResponse,
  type Variant,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { ControlService } from '../ai/control.service';
import { TasksService } from '../ai/tasks.service';
import { AuditService } from '../audit/audit.service';
import { DbService, type Tx } from '../db/db.service';
import {
  cleanOutput,
  factsBlock,
  variantPrompt,
  writePrompt,
  type PromptProduct,
} from './content-prompt';
import { ContentService, type ItemRow } from './content.service';
import { factWarnings } from './fact-check';

const { contentAssets, contentGenerations, contentItemVersions, aiTasks } = schema;
type GenerationRow = typeof contentGenerations.$inferSelect;

const bad = (code: string, message: string) => new BadRequestException({ code, message });

/**
 * AI content writing (spec Part 13, M13). A request becomes an AI task approved by the person who
 * asked (they hold content.generate and set a small budget), so it runs through the same AI Router,
 * failover, cost governor, Emergency Stop and audit as every other AI task. When the task ends, its
 * text becomes the item's next version, checked against the facts it was given.
 */
@Injectable()
export class ContentAiService implements OnModuleInit {
  private readonly logger = new Logger('ContentAi');

  constructor(
    private readonly db: DbService,
    private readonly content: ContentService,
    private readonly tasks: TasksService,
    private readonly control: ControlService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.tasks.onFinished((tenantId, taskId) => this.finish(tenantId, taskId));
  }

  /** The AI writes the next version of an item from verified product facts and references. */
  async generate(ctx: Ctx, itemId: string, raw: Generate): Promise<ItemDetailResponse> {
    const body = generateSchema.parse(raw);
    const { detail, taskId } = await this.db.withContext(ctx, async (tx) => {
      await this.control.assertRunning(tx, ctx.tenantId);
      const item = await this.content.itemIn(tx, ctx, itemId, true);
      writable(item);
      const products = await this.products(tx, ctx, body.productAssetIds);
      const references = await this.references(tx, ctx, body.sourceAssetIds);
      // Keep the current version's sources (a video the text is written for, for example).
      const current = await this.currentVersion(tx, item);
      const sources = [
        ...new Set([
          ...(current?.sourceAssetIds ?? []),
          ...products.map((p) => p.id),
          ...references.map((r) => r.id),
        ]),
      ];
      const prompt = writePrompt(item, products, references, body.brief, body.tone);
      const allowed = [factsBlock(products), body.brief, item.title, item.market].join('\n');
      const taskId = await this.start(tx, ctx, item, {
        mode: 'write',
        prompt,
        allowed,
        productAssetIds: products.map((p) => p.id),
        sourceAssetIds: sources,
        body,
      });
      return { detail: await this.content.detailIn(tx, ctx, item), taskId };
    });
    await this.tasks.start(ctx.tenantId, taskId, ctx.userId);
    return detail;
  }

  /** A new item made from this one's current text in another language, market or platform. */
  async variant(ctx: Ctx, fromId: string, raw: Variant): Promise<ItemDetailResponse> {
    const body = variantSchema.parse(raw);
    const { detail, taskId } = await this.db.withContext(ctx, async (tx) => {
      await this.control.assertRunning(tx, ctx.tenantId);
      const from = await this.content.itemIn(tx, ctx, fromId);
      if (from.status === 'archived') throw bad('CONTENT_STATE', 'Nội dung đã lưu trữ');
      const version = await this.currentVersion(tx, from);
      if (!version?.body?.trim())
        throw bad(
          'CONTENT_NO_TEXT',
          'Bản hiện tại chưa có chữ để chuyển thể. Viết hoặc để AI viết trước.',
        );
      const market = body.market ?? from.market;
      const platform = body.platform ?? from.platform;
      if (body.language === from.language && market === from.market && platform === from.platform)
        throw bad(
          'CONTENT_VARIANT_SAME',
          'Chọn ngôn ngữ, thị trường hoặc nền tảng khác với bản gốc',
        );

      const productIds = await this.productIdsIn(tx, ctx, version.sourceAssetIds);
      const products = await this.products(tx, ctx, productIds);
      const item = await this.content.createItemIn(
        tx,
        ctx,
        createItemSchema.parse({
          title:
            body.title ??
            `${from.title} (${LANGUAGES[body.language] ?? body.language}${platform && platform !== from.platform ? `, ${platform}` : ''})`.slice(
              0,
              200,
            ),
          kind: from.kind,
          language: body.language,
          market,
          platform,
          folderId: from.folderId,
          tags: from.tags,
        }),
        from.id,
      );
      const prompt = variantPrompt(
        { ...from, body: version.body },
        item,
        products,
        body.brief,
        body.tone,
      );
      const allowed = [
        factsBlock(products),
        version.body,
        body.brief,
        from.title,
        item.title,
        market,
      ].join('\n');
      const taskId = await this.start(tx, ctx, item, {
        mode: 'variant',
        prompt,
        allowed,
        productAssetIds: products.map((p) => p.id),
        sourceAssetIds: version.sourceAssetIds,
        from: { id: from.id, version: version.version },
        body,
      });
      return { detail: await this.content.detailIn(tx, ctx, item), taskId };
    });
    await this.tasks.start(ctx.tenantId, taskId, ctx.userId);
    return detail;
  }

  /** Stops a running generation; the task's end marks it cancelled. */
  async cancel(ctx: Ctx, id: string, canApprove: boolean): Promise<ItemDetailResponse> {
    const g = await this.db.withContext(ctx, (tx) => this.generation(tx, ctx, id));
    if (g.status !== 'running')
      throw new ConflictException({ code: 'CONTENT_STATE', message: 'AI không còn đang viết' });
    await this.tasks.cancel(ctx, g.taskId, canApprove);
    return this.db.withContext(ctx, async (tx) =>
      this.content.detailIn(tx, ctx, await this.content.itemIn(tx, ctx, g.itemId)),
    );
  }

  /**
   * Called when any AI task ends. For a content task: saves the text as the next version with its
   * warnings, or records why there is none. Runs as the person who asked, inside one transaction.
   */
  async finish(tenantId: string, taskId: string): Promise<void> {
    await this.db
      .withContext({ tenantId }, async (tx) => {
        const [g] = await tx
          .select()
          .from(contentGenerations)
          .where(
            and(eq(contentGenerations.taskId, taskId), eq(contentGenerations.tenantId, tenantId)),
          )
          .for('update');
        if (!g || g.status !== 'running') return;
        const ctx: Ctx = { tenantId, userId: g.createdBy, ip: null };
        const [task] = await tx.select().from(aiTasks).where(eq(aiTasks.id, taskId));
        if (!task) return;

        if (task.status === 'completed') {
          const text = cleanOutput(task.result ?? '');
          if (!text)
            return this.end(tx, ctx, g, 'failed', {
              errorCode: 'CONTENT_EMPTY',
              errorMessage: 'AI không trả về nội dung',
            });
          const item = await this.content.itemIn(tx, ctx, g.itemId, true);
          if (item.status === 'published' || item.status === 'archived')
            return this.end(tx, ctx, g, 'failed', {
              errorCode: 'CONTENT_STATE',
              errorMessage:
                'Thành phẩm đã xuất bản hoặc lưu trữ trong lúc AI viết, nên không lưu phiên bản mới',
            });
          const warnings = factWarnings(text, g.allowedText);
          // Saved first so the version's blockers see the warnings.
          await tx
            .update(contentGenerations)
            .set({ warnings })
            .where(eq(contentGenerations.id, g.id));
          const saved = await this.content.addTextVersionIn(
            tx,
            ctx,
            item,
            text.slice(0, CONTENT_LIMITS.bodyMaxChars),
            {
              sourceAssetIds: g.sourceAssetIds,
              aiTaskId: taskId,
              note: g.mode === 'variant' ? `AI chuyển thể từ bản ${g.fromVersion}` : 'AI viết',
            },
          );
          return this.end(tx, ctx, g, 'done', { version: saved.currentVersion, warnings });
        }
        if (task.status === 'failed')
          return this.end(tx, ctx, g, 'failed', {
            errorCode: task.errorCode,
            errorMessage: task.progress,
          });
        if (task.status === 'cancelled' || task.status === 'rejected')
          return this.end(tx, ctx, g, 'cancelled', {
            errorCode: 'CANCELLED',
            errorMessage: 'Đã hủy',
          });
        if (task.status === 'paused') {
          // Paused by a person or Emergency Stop. A content task is not resumed (the facts may change
          // meanwhile), so it ends here and can be started again from the item.
          await this.tasks.cancelInTx(tx, tenantId, taskId);
          return this.end(tx, ctx, g, 'cancelled', {
            errorCode: task.errorCode ?? 'PAUSED',
            errorMessage:
              'Đã dừng giữa chừng (tạm dừng hoặc Dừng khẩn cấp). Bấm AI viết để chạy lại.',
          });
        }
      })
      .catch((e: Error) =>
        this.logger.error(`content generation for task ${taskId}: ${e.message}`),
      );
  }

  private async start(
    tx: Tx,
    ctx: Ctx,
    item: ItemRow,
    run: {
      mode: 'write' | 'variant';
      prompt: string;
      allowed: string;
      productAssetIds: string[];
      sourceAssetIds: string[];
      from?: { id: string; version: number };
      body: {
        brief: string | null;
        tone: string | null;
        budgetUsd: number;
        agentId: string | null;
      };
    },
  ): Promise<string> {
    const running = await tx
      .select({ id: contentGenerations.id })
      .from(contentGenerations)
      .where(and(eq(contentGenerations.itemId, item.id), eq(contentGenerations.status, 'running')));
    if (running.length)
      throw new ConflictException({
        code: 'CONTENT_GENERATION_RUNNING',
        message: 'AI đang viết cho thành phẩm này, chờ xong hoặc hủy trước',
      });

    const task = await this.tasks.insert(tx, ctx, {
      title: `${run.mode === 'variant' ? 'AI chuyển thể' : 'AI viết'}: ${item.title}`.slice(0, 200),
      goal: `Viết phiên bản mới cho thành phẩm “${item.title}” trong Kho thành phẩm`,
      scope:
        'Chỉ soạn văn bản từ dữ liệu sản phẩm đã xác minh và tài liệu được chọn; không đăng, không gửi',
      successCriteria:
        'Nội dung đúng nền tảng và ngôn ngữ, chỉ dùng số liệu có trong dữ liệu sản phẩm',
      budgetUsd: run.body.budgetUsd,
      agentId: run.body.agentId,
      requiredLevel: 'prepare',
      timeoutSec: CONTENT_AI_LIMITS.timeoutSec,
      content: { itemId: item.id, prompt: run.prompt },
      approvedBy: ctx.userId,
    });
    const id = uuidv7();
    await tx.insert(contentGenerations).values({
      id,
      tenantId: ctx.tenantId,
      itemId: item.id,
      taskId: task.id,
      mode: run.mode,
      fromItemId: run.from?.id ?? null,
      fromVersion: run.from?.version ?? null,
      productAssetIds: run.productAssetIds,
      sourceAssetIds: run.sourceAssetIds,
      brief: run.body.brief,
      tone: run.body.tone,
      allowedText: run.allowed.slice(0, 400_000),
      createdBy: ctx.userId,
    });
    await this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action: 'content.item.generation_started',
      targetType: 'content_item',
      targetId: item.id,
      metadata: {
        generationId: id,
        taskId: task.id,
        mode: run.mode,
        products: run.productAssetIds.length,
        sources: run.sourceAssetIds.length,
        budgetUsd: run.body.budgetUsd,
        ...(run.from ? { fromItemId: run.from.id, fromVersion: run.from.version } : {}),
      },
      ip: ctx.ip,
    });
    return task.id;
  }

  private async end(
    tx: Tx,
    ctx: Ctx,
    g: GenerationRow,
    status: 'done' | 'failed' | 'cancelled',
    fields: {
      version?: number;
      warnings?: string[];
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    await tx
      .update(contentGenerations)
      .set({
        status,
        version: fields.version ?? null,
        ...(fields.warnings ? { warnings: fields.warnings } : {}),
        errorCode: fields.errorCode ?? null,
        errorMessage: fields.errorMessage?.slice(0, 1000) ?? null,
        finishedAt: new Date(),
      })
      .where(eq(contentGenerations.id, g.id));
    await this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: null,
      action: 'content.item.generation_finished',
      targetType: 'content_item',
      targetId: g.itemId,
      metadata: {
        generationId: g.id,
        taskId: g.taskId,
        status,
        version: fields.version ?? null,
        warnings: fields.warnings?.length ?? 0,
        ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
      },
    });
  }

  /** Product facts the AI may use: each must be a product asset that a person has verified. */
  private async products(
    tx: Tx,
    ctx: Ctx,
    ids: string[],
  ): Promise<(PromptProduct & { id: string })[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select()
      .from(contentAssets)
      .where(and(eq(contentAssets.tenantId, ctx.tenantId), inArray(contentAssets.id, ids)));
    if (rows.length !== ids.length)
      throw bad('CONTENT_SOURCE_NOT_FOUND', 'Có nội dung gốc không tồn tại');
    for (const r of rows) {
      if (r.kind !== 'product' || !r.product)
        throw bad('CONTENT_NOT_PRODUCT', `“${r.title}” không phải thông tin sản phẩm`);
      if (r.archivedAt) throw bad('CONTENT_STATE', `“${r.title}” đã lưu trữ`);
      if (!r.verifiedAt)
        throw bad(
          'CONTENT_FACTS_UNVERIFIED',
          `Thông tin sản phẩm “${r.title}” chưa được xác minh. Người có quyền duyệt cần bấm Xác minh trước khi AI dùng.`,
        );
    }
    return ids.map((id) => {
      const r = rows.find((x) => x.id === id)!;
      return { id, title: r.title, facts: r.product! };
    });
  }

  /** Text and reference sources, cut to a total size. Sources marked "not allowed" are refused. */
  private async references(
    tx: Tx,
    ctx: Ctx,
    ids: string[],
  ): Promise<{ id: string; title: string; body: string }[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select()
      .from(contentAssets)
      .where(and(eq(contentAssets.tenantId, ctx.tenantId), inArray(contentAssets.id, ids)));
    if (rows.length !== ids.length)
      throw bad('CONTENT_SOURCE_NOT_FOUND', 'Có nội dung gốc không tồn tại');
    let left: number = CONTENT_AI_LIMITS.referenceChars;
    return ids.map((id) => {
      const r = rows.find((x) => x.id === id)!;
      if (r.kind === 'product')
        throw bad('CONTENT_USE_PRODUCTS', `Chọn “${r.title}” ở mục thông tin sản phẩm`);
      if (r.kind !== 'text' && r.kind !== 'reference')
        throw bad(
          'CONTENT_NOT_TEXT',
          `AI chỉ đọc được văn bản và nội dung tham khảo, “${r.title}” là tệp`,
        );
      if (r.rightsStatus === 'restricted')
        throw bad('CONTENT_SOURCE_RESTRICTED', `“${r.title}” không được dùng`);
      const body = (r.body ?? '').slice(0, Math.max(0, left));
      left -= body.length;
      return { id, title: r.title, body };
    });
  }

  private async productIdsIn(tx: Tx, ctx: Ctx, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx
      .select({ id: contentAssets.id })
      .from(contentAssets)
      .where(
        and(
          eq(contentAssets.tenantId, ctx.tenantId),
          inArray(contentAssets.id, ids),
          eq(contentAssets.kind, 'product'),
        ),
      );
    return rows.map((r) => r.id).slice(0, CONTENT_AI_LIMITS.productsMax);
  }

  private async currentVersion(tx: Tx, item: ItemRow) {
    if (item.currentVersion === 0) return null;
    const [v] = await tx
      .select()
      .from(contentItemVersions)
      .where(
        and(
          eq(contentItemVersions.itemId, item.id),
          eq(contentItemVersions.version, item.currentVersion),
        ),
      );
    return v ?? null;
  }

  private async generation(tx: Tx, ctx: Ctx, id: string): Promise<GenerationRow> {
    const [g] = await tx
      .select()
      .from(contentGenerations)
      .where(and(eq(contentGenerations.id, id), eq(contentGenerations.tenantId, ctx.tenantId)));
    if (!g)
      throw new NotFoundException({
        code: 'CONTENT_NOT_FOUND',
        message: 'Không tìm thấy lượt AI viết',
      });
    return g;
  }
}

function writable(item: ItemRow): void {
  if (item.status === 'published')
    throw new ConflictException({
      code: 'CONTENT_STATE',
      message: 'Nội dung đã xuất bản không sửa được. Tạo thành phẩm mới hoặc bản chuyển thể.',
    });
  if (item.status === 'archived')
    throw new ConflictException({ code: 'CONTENT_STATE', message: 'Nội dung đã lưu trữ' });
}
