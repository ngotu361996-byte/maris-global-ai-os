import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  and,
  arrayContains,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  createAssetSchema,
  createFolderSchema,
  createItemSchema,
  createVersionSchema,
  publishSchema,
  reviewSchema,
  updateAssetSchema,
  updateItemSchema,
  USABLE_RIGHTS,
  type AssetKind,
  type AssetResponse,
  type ContentLibrary,
  type CreateAsset,
  type CreateFolder,
  type CreateItem,
  type CreateVersion,
  type FileInfo,
  type FolderResponse,
  type GenerationResponse,
  type ItemDetailResponse,
  type ItemResponse,
  type ItemStatus,
  type Publish,
  type Review,
  type RightsStatus,
  type UpdateAsset,
  type UpdateItem,
  type VersionResponse,
  type assetsQuery,
  type itemsQuery,
  type uploadAssetQuery,
} from '@maris/contracts';
import type { z } from 'zod';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { FileTooLargeError, LocalFileStorage, type StagedFile } from '../files/file-storage';
import { cleanFileName, detectType, type DetectedType } from '../files/file-type';

const {
  contentFolders,
  contentAssets,
  contentItems,
  contentItemVersions,
  contentGenerations,
  users,
  aiSkills,
  aiTasks,
  workflowRuns,
} = schema;
type AssetRow = typeof contentAssets.$inferSelect;
type ItemRow = typeof contentItems.$inferSelect;
type VersionRow = typeof contentItemVersions.$inferSelect;
type GenerationRow = typeof contentGenerations.$inferSelect;
export type { ItemRow, AssetRow };

/** Media the browser may show inline (with a sandboxing CSP). Everything else is a download. */
const INLINE_MIME =
  /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|ogg|wav))$/;

const notFound = (what: string) =>
  new NotFoundException({ code: 'CONTENT_NOT_FOUND', message: `Không tìm thấy ${what}` });
const badState = (message: string) => new ConflictException({ code: 'CONTENT_STATE', message });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const likeEscape = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const rightsUsable = (
  status: RightsStatus,
  expiresAt: Date | null,
  now = new Date(),
): boolean => USABLE_RIGHTS.includes(status) && (!expiresAt || expiresAt.getTime() > now.getTime());

/** Strips an incomplete UTF-8 character at the end of a cut buffer, so text detection still works. */
function trimUtf8(buf: Buffer): Buffer {
  for (let back = 1; back <= 3 && back <= buf.length; back++) {
    const b = buf[buf.length - back]!;
    if ((b & 0xc0) === 0x80) continue; // continuation byte, keep looking for the lead byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? buf.subarray(0, buf.length - back) : buf;
  }
  return buf;
}

export interface StoredFile {
  name: string;
  type: DetectedType;
  size: number;
  sha256: string;
  storageKey: string;
  staged: StagedFile;
}

/**
 * Content libraries (spec Part 11). Originals are never overwritten (also enforced by a trigger):
 * only an asset's description, folder, tags and rights can change. Finished items gain numbered
 * versions; a version is written once. An item can only be approved while every source of its
 * current version has usable rights.
 */
@Injectable()
export class ContentService {
  private readonly storage: LocalFileStorage;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.storage = new LocalFileStorage(join(config.FILE_STORAGE_DIR, 'content'));
  }

  // -------------------------------------------------------------------------------- folders

  listFolders(ctx: Ctx, library: ContentLibrary): Promise<FolderResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(contentFolders)
        .where(
          and(
            eq(contentFolders.tenantId, ctx.tenantId),
            eq(contentFolders.library, library),
            isNull(contentFolders.deletedAt),
          ),
        )
        .orderBy(contentFolders.name);
      const table = library === 'source' ? contentAssets : contentItems;
      const counts = await tx
        .select({ folderId: table.folderId, n: sql<number>`count(*)::int` })
        .from(table)
        .where(
          and(
            eq(table.tenantId, ctx.tenantId),
            isNotNull(table.folderId),
            library === 'source'
              ? isNull(contentAssets.archivedAt)
              : sql`${contentItems.status} <> 'archived'`,
          ),
        )
        .groupBy(table.folderId);
      const byFolder = new Map(counts.map((c) => [c.folderId, c.n]));
      return rows.map((f) => ({
        id: f.id,
        library: f.library,
        name: f.name,
        parentId: f.parentId,
        count: byFolder.get(f.id) ?? 0,
      }));
    });
  }

  createFolder(ctx: Ctx, raw: CreateFolder): Promise<FolderResponse> {
    const body = createFolderSchema.parse(raw);
    return this.db.withContext(ctx, async (tx) => {
      if (body.parentId) await this.folder(tx, ctx, body.parentId, body.library);
      const id = uuidv7();
      try {
        await tx.insert(contentFolders).values({
          id,
          tenantId: ctx.tenantId,
          library: body.library,
          name: body.name,
          parentId: body.parentId,
          createdBy: ctx.userId,
        });
      } catch (e) {
        throw duplicateName(e);
      }
      await this.log(tx, ctx, 'content.folder.created', 'content_folder', id, {
        library: body.library,
        name: body.name,
      });
      return { id, library: body.library, name: body.name, parentId: body.parentId, count: 0 };
    });
  }

  renameFolder(ctx: Ctx, id: string, name: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      const f = await this.folder(tx, ctx, id);
      try {
        await tx.update(contentFolders).set({ name }).where(eq(contentFolders.id, id));
      } catch (e) {
        throw duplicateName(e);
      }
      await this.log(tx, ctx, 'content.folder.renamed', 'content_folder', id, {
        from: f.name,
        to: name,
      });
    });
  }

  /** Only an empty folder can be removed. */
  deleteFolder(ctx: Ctx, id: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      const f = await this.folder(tx, ctx, id);
      const [a] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(contentAssets)
        .where(and(eq(contentAssets.folderId, id), isNull(contentAssets.archivedAt)));
      const [i] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(contentItems)
        .where(and(eq(contentItems.folderId, id), sql`${contentItems.status} <> 'archived'`));
      const [c] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(contentFolders)
        .where(and(eq(contentFolders.parentId, id), isNull(contentFolders.deletedAt)));
      if (a!.n + i!.n + c!.n > 0) throw badState('Thư mục còn nội dung hoặc thư mục con');
      await tx
        .update(contentFolders)
        .set({ deletedAt: new Date() })
        .where(eq(contentFolders.id, id));
      await this.log(tx, ctx, 'content.folder.deleted', 'content_folder', id, { name: f.name });
    });
  }

  // -------------------------------------------------------------------------------- assets

  listAssets(ctx: Ctx, q: z.infer<typeof assetsQuery>): Promise<AssetResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const where: SQL[] = [eq(contentAssets.tenantId, ctx.tenantId)];
      where.push(
        q.archived ? isNotNull(contentAssets.archivedAt) : isNull(contentAssets.archivedAt),
      );
      if (q.kind) where.push(eq(contentAssets.kind, q.kind));
      if (q.folderId) where.push(eq(contentAssets.folderId, q.folderId));
      if (q.rights) where.push(eq(contentAssets.rightsStatus, q.rights));
      if (q.tag) where.push(arrayContains(contentAssets.tags, [q.tag]));
      if (q.q) {
        const like = likeEscape(q.q);
        where.push(
          or(
            ilike(contentAssets.title, like),
            ilike(contentAssets.description, like),
            ilike(contentAssets.fileName, like),
            sql`array_to_string(${contentAssets.tags}, ' ') ILIKE ${like}`,
          )!,
        );
      }
      const rows = await tx
        .select()
        .from(contentAssets)
        .where(and(...where))
        .orderBy(desc(contentAssets.createdAt))
        .limit(q.limit);
      return this.assetResponses(tx, rows);
    });
  }

  getAsset(ctx: Ctx, id: string): Promise<AssetResponse> {
    return this.db.withContext(
      ctx,
      async (tx) => (await this.assetResponses(tx, [await this.asset(tx, ctx, id)]))[0]!,
    );
  }

  createAsset(ctx: Ctx, raw: CreateAsset): Promise<AssetResponse> {
    const body = createAssetSchema.parse(raw);
    const text = body.kind === 'product' ? null : body.body;
    const product = body.kind === 'product' ? body.product : null;
    const hash = sha256(product ? JSON.stringify(product) : text!.trim());
    return this.db.withContext(ctx, async (tx) => {
      if (body.folderId) await this.folder(tx, ctx, body.folderId, 'source');
      await this.noDuplicate(tx, ctx, hash);
      const id = uuidv7();
      const [row] = await tx
        .insert(contentAssets)
        .values({
          id,
          tenantId: ctx.tenantId,
          folderId: body.folderId,
          title: body.title,
          kind: body.kind,
          description: body.description,
          body: text,
          product,
          contentSha256: hash,
          source: body.source,
          sourceRef: body.sourceRef,
          rightsStatus: body.rightsStatus,
          rightsHolder: body.rightsHolder,
          rightsNote: body.rightsNote,
          rightsExpiresAt: body.rightsExpiresAt ? new Date(body.rightsExpiresAt) : null,
          tags: body.tags,
          createdBy: ctx.userId,
        })
        .returning();
      await this.log(tx, ctx, 'content.asset.created', 'content_asset', id, {
        kind: body.kind,
        source: body.source,
        rights: body.rightsStatus,
      });
      return (await this.assetResponses(tx, [row!]))[0]!;
    });
  }

  /** Streams an upload to storage, detects its type from the bytes, refuses duplicates, then records it. */
  async uploadAsset(
    ctx: Ctx,
    rawName: string,
    body: Readable,
    meta: z.infer<typeof uploadAssetQuery>,
  ): Promise<AssetResponse> {
    const file = await this.receive(ctx, rawName, body);
    try {
      const kind: AssetKind = file.type.kind === 'text' ? 'document' : file.type.kind;
      return await this.db.withContext(ctx, async (tx) => {
        if (meta.folderId) await this.folder(tx, ctx, meta.folderId, 'source');
        await this.noDuplicate(tx, ctx, file.sha256);
        const id = uuidv7();
        const [row] = await tx
          .insert(contentAssets)
          .values({
            id,
            tenantId: ctx.tenantId,
            folderId: meta.folderId ?? null,
            title:
              meta.title ??
              (file.name.replace(/\.[^.]+$/, '').slice(0, 200) || file.name.slice(0, 200)),
            kind,
            fileName: file.name,
            mime: file.type.mime,
            sizeBytes: file.size,
            storageKey: file.storageKey,
            contentSha256: file.sha256,
            source: 'upload',
            sourceRef: meta.sourceRef ?? null,
            rightsStatus: meta.rightsStatus,
            rightsHolder: meta.rightsHolder ?? null,
            tags: meta.tags,
            createdBy: ctx.userId,
          })
          .returning();
        await this.log(tx, ctx, 'content.asset.created', 'content_asset', id, {
          kind,
          source: 'upload',
          mime: file.type.mime,
          sizeBytes: file.size,
          sha256: file.sha256,
          rights: meta.rightsStatus,
        });
        await file.staged.commit();
        return (await this.assetResponses(tx, [row!]))[0]!;
      });
    } catch (e) {
      await file.staged.discard();
      throw e;
    }
  }

  updateAsset(ctx: Ctx, id: string, raw: UpdateAsset): Promise<AssetResponse> {
    const body = updateAssetSchema.parse(raw);
    return this.db.withContext(ctx, async (tx) => {
      const before = await this.asset(tx, ctx, id);
      if (body.folderId) await this.folder(tx, ctx, body.folderId, 'source');
      const [row] = await tx
        .update(contentAssets)
        .set({
          ...body,
          rightsExpiresAt:
            body.rightsExpiresAt === undefined
              ? undefined
              : body.rightsExpiresAt
                ? new Date(body.rightsExpiresAt)
                : null,
          updatedAt: new Date(),
        })
        .where(eq(contentAssets.id, id))
        .returning();
      const changes: Record<string, unknown> = { fields: Object.keys(body) };
      if (body.rightsStatus && body.rightsStatus !== before.rightsStatus)
        changes.rights = { from: before.rightsStatus, to: body.rightsStatus };
      await this.log(tx, ctx, 'content.asset.updated', 'content_asset', id, changes);
      return (await this.assetResponses(tx, [row!]))[0]!;
    });
  }

  /** Marks product facts or a text as checked, so AI may rely on them. */
  verifyAsset(ctx: Ctx, id: string): Promise<AssetResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const a = await this.asset(tx, ctx, id);
      if (a.storageKey)
        throw new BadRequestException({
          code: 'CONTENT_NOT_VERIFIABLE',
          message: 'Chỉ xác minh được thông tin sản phẩm, văn bản và tham khảo',
        });
      const [row] = await tx
        .update(contentAssets)
        .set({ verifiedBy: ctx.userId, verifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(contentAssets.id, id))
        .returning();
      await this.log(tx, ctx, 'content.asset.verified', 'content_asset', id, { kind: a.kind });
      return (await this.assetResponses(tx, [row!]))[0]!;
    });
  }

  setArchived(ctx: Ctx, id: string, archived: boolean): Promise<AssetResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const a = await this.asset(tx, ctx, id);
      if (!archived && a.archivedAt) await this.noDuplicate(tx, ctx, a.contentSha256);
      const [row] = await tx
        .update(contentAssets)
        .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
        .where(eq(contentAssets.id, id))
        .returning();
      await this.log(
        tx,
        ctx,
        archived ? 'content.asset.archived' : 'content.asset.restored',
        'content_asset',
        id,
        {},
      );
      return (await this.assetResponses(tx, [row!]))[0]!;
    });
  }

  async assetFile(ctx: Ctx, id: string) {
    const a = await this.db.withContext(ctx, (tx) => this.asset(tx, ctx, id));
    if (!a.storageKey) throw notFound('tệp');
    return {
      ...(await this.storage.open(a.storageKey)),
      name: a.fileName!,
      mime: a.mime!,
      inlineOk: INLINE_MIME.test(a.mime!),
    };
  }

  // -------------------------------------------------------------------------------- items

  listItems(ctx: Ctx, q: z.infer<typeof itemsQuery>): Promise<ItemResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const where: SQL[] = [eq(contentItems.tenantId, ctx.tenantId)];
      if (q.status) where.push(eq(contentItems.status, q.status));
      else where.push(sql`${contentItems.status} <> 'archived'`);
      if (q.kind) where.push(eq(contentItems.kind, q.kind));
      if (q.platform) where.push(eq(contentItems.platform, q.platform));
      if (q.language) where.push(eq(contentItems.language, q.language));
      if (q.folderId) where.push(eq(contentItems.folderId, q.folderId));
      if (q.tag) where.push(arrayContains(contentItems.tags, [q.tag]));
      if (q.q) {
        const like = likeEscape(q.q);
        where.push(
          or(
            ilike(contentItems.title, like),
            sql`array_to_string(${contentItems.tags}, ' ') ILIKE ${like}`,
          )!,
        );
      }
      if (q.sourceAssetId)
        where.push(
          sql`EXISTS (SELECT 1 FROM content.item_versions v WHERE v.item_id = ${contentItems.id} AND v.source_asset_ids @> ARRAY[${q.sourceAssetId}]::uuid[])`,
        );
      const rows = await tx
        .select()
        .from(contentItems)
        .where(and(...where))
        .orderBy(desc(contentItems.updatedAt))
        .limit(q.limit);
      const names = await this.names(
        tx,
        rows.flatMap((r) => [r.createdBy, r.reviewedBy]),
      );
      return rows.map((r) => itemResponse(r, names));
    });
  }

  getItem(ctx: Ctx, id: string): Promise<ItemDetailResponse> {
    return this.db.withContext(ctx, async (tx) =>
      this.detail(tx, ctx, await this.item(tx, ctx, id)),
    );
  }

  createItem(ctx: Ctx, raw: CreateItem): Promise<ItemDetailResponse> {
    const body = createItemSchema.parse(raw);
    return this.db.withContext(ctx, async (tx) =>
      this.detail(tx, ctx, await this.createItemIn(tx, ctx, body, null)),
    );
  }

  /** Creates an item inside the caller's transaction; variantOf links a language or platform copy. */
  async createItemIn(
    tx: Tx,
    ctx: Ctx,
    body: z.output<typeof createItemSchema>,
    variantOf: string | null,
  ): Promise<ItemRow> {
    {
      if (body.folderId) await this.folder(tx, ctx, body.folderId, 'output');
      const id = uuidv7();
      let [row] = await tx
        .insert(contentItems)
        .values({
          id,
          tenantId: ctx.tenantId,
          folderId: body.folderId,
          title: body.title,
          kind: body.kind,
          language: body.language,
          market: body.market,
          platform: body.platform,
          tags: body.tags,
          variantOf,
          createdBy: ctx.userId,
        })
        .returning();
      await this.log(tx, ctx, 'content.item.created', 'content_item', id, {
        kind: body.kind,
        language: body.language,
        platform: body.platform,
        ...(variantOf ? { variantOf } : {}),
      });
      if (body.body) row = await this.addVersion(tx, ctx, row!, { body: body.body }, body);
      return row!;
    }
  }

  /** Adds a text version inside the caller's transaction (used by AI content writing). */
  addTextVersionIn(
    tx: Tx,
    ctx: Ctx,
    item: ItemRow,
    body: string,
    lineage: { sourceAssetIds: string[]; aiTaskId: string; note: string },
  ): Promise<ItemRow> {
    return this.addVersion(
      tx,
      ctx,
      item,
      { body },
      { ...lineage, skillId: null, workflowRunId: null },
    );
  }

  /** Adds a file version inside the caller's transaction (used by the Media Worker outputs). */
  addFileVersionIn(
    tx: Tx,
    ctx: Ctx,
    item: ItemRow,
    file: StoredFile,
    lineage: { sourceAssetIds: string[]; workerJobId: string; note: string },
  ): Promise<ItemRow> {
    return this.addVersion(
      tx,
      ctx,
      item,
      { file },
      { ...lineage, skillId: null, workflowRunId: null, aiTaskId: null },
    );
  }

  /** Streams a file to staging and detects its type; the caller commits or discards it. */
  receiveFile(ctx: Ctx, rawName: string, body: Readable): Promise<StoredFile> {
    return this.receive(ctx, rawName, body);
  }

  assetIn(tx: Tx, ctx: Ctx, id: string): Promise<AssetRow> {
    return this.asset(tx, ctx, id);
  }

  /** The folder, or an error when it is not a folder of that library. */
  folderIn(tx: Tx, ctx: Ctx, id: string, library: ContentLibrary) {
    return this.folder(tx, ctx, id, library);
  }

  /** Reads (and with lock, locks) an item of the caller's tenant. */
  itemIn(tx: Tx, ctx: Ctx, id: string, lock = false): Promise<ItemRow> {
    return this.item(tx, ctx, id, lock);
  }

  detailIn(tx: Tx, ctx: Ctx, item: ItemRow): Promise<ItemDetailResponse> {
    return this.detail(tx, ctx, item);
  }

  updateItem(ctx: Ctx, id: string, raw: UpdateItem): Promise<ItemDetailResponse> {
    const body = updateItemSchema.parse(raw);
    return this.db.withContext(ctx, async (tx) => {
      const item = await this.item(tx, ctx, id, true);
      if (item.status === 'archived') throw badState('Nội dung đã lưu trữ');
      if (body.folderId) await this.folder(tx, ctx, body.folderId, 'output');
      const [row] = await tx
        .update(contentItems)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(contentItems.id, id))
        .returning();
      await this.log(tx, ctx, 'content.item.updated', 'content_item', id, {
        fields: Object.keys(body),
      });
      return this.detail(tx, ctx, row!);
    });
  }

  createVersion(ctx: Ctx, id: string, raw: CreateVersion): Promise<ItemDetailResponse> {
    const body = createVersionSchema.parse(raw);
    return this.db.withContext(ctx, async (tx) => {
      const item = await this.item(tx, ctx, id, true);
      return this.detail(tx, ctx, await this.addVersion(tx, ctx, item, { body: body.body }, body));
    });
  }

  async uploadVersion(
    ctx: Ctx,
    id: string,
    rawName: string,
    body: Readable,
    meta: { sourceAssetIds: string[]; note?: string },
  ): Promise<ItemDetailResponse> {
    // Check the item before receiving a large file.
    await this.db.withContext(ctx, async (tx) => editable(await this.item(tx, ctx, id)));
    const file = await this.receive(ctx, rawName, body);
    try {
      return await this.db.withContext(ctx, async (tx) => {
        const item = await this.item(tx, ctx, id, true);
        const row = await this.addVersion(
          tx,
          ctx,
          item,
          { file },
          {
            sourceAssetIds: [...new Set(meta.sourceAssetIds)],
            skillId: null,
            workflowRunId: null,
            aiTaskId: null,
            note: meta.note ?? null,
          },
        );
        await file.staged.commit();
        return this.detail(tx, ctx, row);
      });
    } catch (e) {
      await file.staged.discard();
      throw e;
    }
  }

  async versionFile(ctx: Ctx, id: string, version: number) {
    const v = await this.db.withContext(ctx, async (tx) => {
      await this.item(tx, ctx, id);
      const [row] = await tx
        .select()
        .from(contentItemVersions)
        .where(and(eq(contentItemVersions.itemId, id), eq(contentItemVersions.version, version)));
      return row;
    });
    if (!v?.storageKey) throw notFound('tệp của phiên bản này');
    return {
      ...(await this.storage.open(v.storageKey)),
      name: v.fileName!,
      mime: v.mime!,
      inlineOk: INLINE_MIME.test(v.mime!),
    };
  }

  submit(ctx: Ctx, id: string): Promise<ItemDetailResponse> {
    return this.transition(
      ctx,
      id,
      ['draft', 'rejected'],
      'in_review',
      'content.item.submitted',
      (item) => {
        if (item.currentVersion < 1) throw badState('Chưa có phiên bản nào để duyệt');
        return { submittedBy: ctx.userId, submittedAt: new Date(), reviewNote: null };
      },
    );
  }

  approve(ctx: Ctx, id: string, raw: Review): Promise<ItemDetailResponse> {
    const { note } = reviewSchema.parse(raw);
    return this.db.withContext(ctx, async (tx) => {
      const item = await this.item(tx, ctx, id, true);
      if (item.status !== 'in_review') throw badState('Chỉ duyệt được nội dung đang chờ duyệt');
      const blockers = await this.blockers(tx, ctx, item);
      if (blockers.length > 0)
        throw new ConflictException({
          code: 'CONTENT_RIGHTS_BLOCKED',
          message: `Chưa duyệt được: ${blockers.join('; ')}`,
        });
      return this.applyTransition(
        tx,
        ctx,
        item,
        'approved',
        'content.item.approved',
        {
          reviewedBy: ctx.userId,
          reviewedAt: new Date(),
          reviewNote: note,
        },
        { version: item.currentVersion },
      );
    });
  }

  reject(ctx: Ctx, id: string, raw: Review): Promise<ItemDetailResponse> {
    const { note } = reviewSchema.parse(raw);
    return this.transition(ctx, id, ['in_review'], 'rejected', 'content.item.rejected', () => ({
      reviewedBy: ctx.userId,
      reviewedAt: new Date(),
      reviewNote: note,
    }));
  }

  publish(ctx: Ctx, id: string, raw: Publish): Promise<ItemDetailResponse> {
    const { url } = publishSchema.parse(raw);
    return this.transition(ctx, id, ['approved'], 'published', 'content.item.published', () => ({
      publishedUrl: url,
      publishedAt: new Date(),
    }));
  }

  archive(ctx: Ctx, id: string): Promise<ItemDetailResponse> {
    return this.transition(
      ctx,
      id,
      ['draft', 'in_review', 'approved', 'rejected', 'published'],
      'archived',
      'content.item.archived',
      () => ({}),
    );
  }

  // -------------------------------------------------------------------------------- internals

  private transition(
    ctx: Ctx,
    id: string,
    from: ItemStatus[],
    to: ItemStatus,
    action: string,
    fields: (item: ItemRow) => Partial<ItemRow>,
  ): Promise<ItemDetailResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const item = await this.item(tx, ctx, id, true);
      if (!from.includes(item.status))
        throw badState(`Không thể chuyển từ “${item.status}” sang “${to}”`);
      return this.applyTransition(tx, ctx, item, to, action, fields(item), {
        version: item.currentVersion,
      });
    });
  }

  private async applyTransition(
    tx: Tx,
    ctx: Ctx,
    item: ItemRow,
    to: ItemStatus,
    action: string,
    fields: Partial<ItemRow>,
    meta: Record<string, unknown>,
  ) {
    const [row] = await tx
      .update(contentItems)
      .set({ ...fields, status: to, updatedAt: new Date() })
      .where(eq(contentItems.id, item.id))
      .returning();
    await this.log(tx, ctx, action, 'content_item', item.id, {
      ...meta,
      from: item.status,
      to,
      ...(fields.reviewNote ? { note: fields.reviewNote } : {}),
    });
    return this.detail(tx, ctx, row!);
  }

  /** Adds the next version. Any change sends an item back to draft, so it is approved again. */
  private async addVersion(
    tx: Tx,
    ctx: Ctx,
    item: ItemRow,
    data: { body?: string; file?: StoredFile },
    lineage: {
      sourceAssetIds: string[];
      skillId: string | null;
      workflowRunId: string | null;
      aiTaskId: string | null;
      note: string | null;
      workerJobId?: string | null;
    },
  ): Promise<ItemRow> {
    editable(item);
    if (lineage.sourceAssetIds.length > 0) {
      const found = await tx
        .select({ id: contentAssets.id })
        .from(contentAssets)
        .where(
          and(
            eq(contentAssets.tenantId, ctx.tenantId),
            inArray(contentAssets.id, lineage.sourceAssetIds),
          ),
        );
      if (found.length !== lineage.sourceAssetIds.length)
        throw new BadRequestException({
          code: 'CONTENT_SOURCE_NOT_FOUND',
          message: 'Có nội dung gốc không tồn tại',
        });
    }
    let skillVersion: string | null = null;
    if (lineage.skillId) {
      const [s] = await tx
        .select({ version: aiSkills.version })
        .from(aiSkills)
        .where(and(eq(aiSkills.id, lineage.skillId), eq(aiSkills.tenantId, ctx.tenantId)));
      if (!s)
        throw new BadRequestException({
          code: 'CONTENT_SKILL_NOT_FOUND',
          message: 'Không có Skill đó',
        });
      skillVersion = s.version;
    }
    if (lineage.workflowRunId) {
      const [w] = await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
          and(eq(workflowRuns.id, lineage.workflowRunId), eq(workflowRuns.tenantId, ctx.tenantId)),
        );
      if (!w)
        throw new BadRequestException({
          code: 'CONTENT_RUN_NOT_FOUND',
          message: 'Không có lượt chạy Workflow đó',
        });
    }
    if (lineage.aiTaskId) {
      const [t] = await tx
        .select({ id: aiTasks.id })
        .from(aiTasks)
        .where(and(eq(aiTasks.id, lineage.aiTaskId), eq(aiTasks.tenantId, ctx.tenantId)));
      if (!t)
        throw new BadRequestException({
          code: 'CONTENT_TASK_NOT_FOUND',
          message: 'Không có việc AI đó',
        });
    }
    const version = item.currentVersion + 1;
    const f = data.file;
    await tx.insert(contentItemVersions).values({
      id: uuidv7(),
      tenantId: ctx.tenantId,
      itemId: item.id,
      version,
      body: data.body ?? null,
      fileName: f?.name ?? null,
      mime: f?.type.mime ?? null,
      sizeBytes: f?.size ?? null,
      sha256: f?.sha256 ?? (data.body ? sha256(data.body) : null),
      storageKey: f?.storageKey ?? null,
      sourceAssetIds: lineage.sourceAssetIds,
      skillId: lineage.skillId,
      skillVersion,
      workflowRunId: lineage.workflowRunId,
      aiTaskId: lineage.aiTaskId,
      workerJobId: lineage.workerJobId ?? null,
      note: lineage.note,
      createdBy: ctx.userId,
    });
    const [row] = await tx
      .update(contentItems)
      .set({
        currentVersion: version,
        status: 'draft',
        reviewNote: null,
        reviewedBy: null,
        reviewedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(contentItems.id, item.id))
      .returning();
    await this.log(tx, ctx, 'content.item.version_added', 'content_item', item.id, {
      version,
      previousStatus: item.status,
      sources: lineage.sourceAssetIds.length,
      ...(f ? { mime: f.type.mime, sizeBytes: f.size, sha256: f.sha256 } : {}),
      ...(lineage.skillId ? { skillId: lineage.skillId, skillVersion } : {}),
      ...(lineage.workflowRunId ? { workflowRunId: lineage.workflowRunId } : {}),
      ...(lineage.aiTaskId ? { aiTaskId: lineage.aiTaskId } : {}),
      ...(lineage.workerJobId ? { workerJobId: lineage.workerJobId } : {}),
    });
    return row!;
  }

  private async receive(ctx: Ctx, rawName: string, body: Readable): Promise<StoredFile> {
    const name = cleanFileName(rawName);
    const storageKey = `${ctx.tenantId}/${uuidv7()}`;
    let staged: StagedFile;
    try {
      staged = await this.storage.putStream(
        storageKey,
        body,
        this.config.CONTENT_MAX_MB * 1024 * 1024,
      );
    } catch (e) {
      if (e instanceof FileTooLargeError)
        throw new PayloadTooLargeException({
          code: 'FILE_TOO_LARGE',
          message: `Tệp lớn hơn ${this.config.CONTENT_MAX_MB} MB`,
        });
      throw e;
    }
    if (staged.size === 0) {
      await staged.discard();
      throw new BadRequestException({ code: 'FILE_EMPTY', message: 'Tệp rỗng' });
    }
    const type =
      detectType(staged.head, name) ??
      (staged.head.length >= 64 * 1024 ? detectType(trimUtf8(staged.head), name) : null);
    if (!type) {
      await staged.discard();
      throw new HttpException(
        {
          code: 'FILE_TYPE_NOT_ALLOWED',
          message:
            'Loại tệp này chưa được hỗ trợ. Dùng video (MP4, MOV, WEBM), ảnh (PNG, JPG, GIF, WEBP), âm thanh, PDF, Word/Excel/PowerPoint hoặc văn bản.',
        },
        415,
      );
    }
    return { name, type, size: staged.size, sha256: staged.sha256, storageKey, staged };
  }

  /** One check at a time per content hash, so two equal uploads cannot both get in. */
  private async noDuplicate(tx: Tx, ctx: Ctx, hash: string): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`content:${ctx.tenantId}:${hash}`}, 0))`,
    );
    const [dup] = await tx
      .select({ id: contentAssets.id, title: contentAssets.title })
      .from(contentAssets)
      .where(
        and(
          eq(contentAssets.tenantId, ctx.tenantId),
          eq(contentAssets.contentSha256, hash),
          isNull(contentAssets.archivedAt),
        ),
      )
      .limit(1);
    if (dup)
      throw new ConflictException({
        code: 'CONTENT_DUPLICATE',
        message: `Nội dung này đã có trong kho: “${dup.title}” (${dup.id})`,
      });
  }

  private async blockers(tx: Tx, ctx: Ctx, item: ItemRow): Promise<string[]> {
    const [v] = await tx
      .select()
      .from(contentItemVersions)
      .where(
        and(
          eq(contentItemVersions.itemId, item.id),
          eq(contentItemVersions.version, item.currentVersion),
        ),
      );
    if (!v) return ['chưa có phiên bản'];
    const out: string[] = [];
    if (v.aiTaskId) {
      const [g] = await tx
        .select({ warnings: contentGenerations.warnings })
        .from(contentGenerations)
        .where(eq(contentGenerations.taskId, v.aiTaskId));
      if (g?.warnings.length)
        out.push(
          `phiên bản do AI viết có điểm chưa có căn cứ (${g.warnings.join('; ')}). Sửa lại rồi lưu thành phiên bản mới`,
        );
    }
    if (v.sourceAssetIds.length === 0) return out;
    const sources = await tx
      .select()
      .from(contentAssets)
      .where(
        and(eq(contentAssets.tenantId, ctx.tenantId), inArray(contentAssets.id, v.sourceAssetIds)),
      );
    return [
      ...out,
      ...sources
        .filter((s) => !rightsUsable(s.rightsStatus, s.rightsExpiresAt))
        .map((s) =>
          s.rightsStatus === 'restricted'
            ? `nguồn “${s.title}” không được dùng`
            : USABLE_RIGHTS.includes(s.rightsStatus)
              ? `quyền dùng nguồn “${s.title}” đã hết hạn`
              : `nguồn “${s.title}” chưa rõ quyền sử dụng`,
        ),
    ];
  }

  private async detail(tx: Tx, ctx: Ctx, item: ItemRow): Promise<ItemDetailResponse> {
    const versions = await tx
      .select()
      .from(contentItemVersions)
      .where(eq(contentItemVersions.itemId, item.id))
      .orderBy(desc(contentItemVersions.version));
    const sourceIds = [...new Set(versions.flatMap((v) => v.sourceAssetIds))];
    const sources = sourceIds.length
      ? await tx
          .select()
          .from(contentAssets)
          .where(
            and(eq(contentAssets.tenantId, ctx.tenantId), inArray(contentAssets.id, sourceIds)),
          )
      : [];
    const sourceById = new Map(sources.map((s) => [s.id, s]));
    const skillIds = [...new Set(versions.map((v) => v.skillId).filter((x): x is string => !!x))];
    const skills = skillIds.length
      ? await tx
          .select({ id: aiSkills.id, name: aiSkills.name })
          .from(aiSkills)
          .where(inArray(aiSkills.id, skillIds))
      : [];
    const skillName = new Map(skills.map((s) => [s.id, s.name]));
    const generations = await tx
      .select({ g: contentGenerations, progress: aiTasks.progress, costUsd: aiTasks.costUsd })
      .from(contentGenerations)
      .innerJoin(aiTasks, eq(aiTasks.id, contentGenerations.taskId))
      .where(eq(contentGenerations.itemId, item.id))
      .orderBy(desc(contentGenerations.createdAt))
      .limit(20);
    const warningsByTask = new Map(generations.map(({ g }) => [g.taskId, g.warnings]));
    const variants = await tx
      .select({
        id: contentItems.id,
        title: contentItems.title,
        language: contentItems.language,
        platform: contentItems.platform,
        status: contentItems.status,
      })
      .from(contentItems)
      .where(and(eq(contentItems.tenantId, ctx.tenantId), eq(contentItems.variantOf, item.id)))
      .orderBy(desc(contentItems.createdAt));
    const names = await this.names(tx, [
      item.createdBy,
      item.reviewedBy,
      ...versions.map((v) => v.createdBy),
      ...generations.map(({ g }) => g.createdBy),
    ]);
    return {
      ...itemResponse(item, names),
      versions: versions.map((v) =>
        versionResponse(
          v,
          sourceById,
          skillName,
          names,
          v.aiTaskId ? warningsByTask.get(v.aiTaskId) : undefined,
        ),
      ),
      generations: generations.map(({ g, progress, costUsd }) =>
        generationResponse(g, names, g.status === 'running' ? progress : null, Number(costUsd)),
      ),
      variants,
      approvalBlockers:
        item.status === 'archived' || item.status === 'published'
          ? []
          : await this.blockers(tx, ctx, item),
    };
  }

  private async assetResponses(tx: Tx, rows: AssetRow[]): Promise<AssetResponse[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const used = await tx.execute(sql`
      SELECT a.id::text AS id, count(DISTINCT v.item_id)::int AS n
      FROM unnest(ARRAY[${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )}]::uuid[]) AS a(id)
      JOIN content.item_versions v ON v.source_asset_ids @> ARRAY[a.id]
      GROUP BY a.id`);
    const usedBy = new Map(
      (used as unknown as { id: string; n: number }[]).map((u) => [u.id, u.n]),
    );
    const names = await this.names(
      tx,
      rows.flatMap((r) => [r.createdBy, r.verifiedBy]),
    );
    return rows.map((r) => assetResponse(r, names, usedBy.get(r.id) ?? 0));
  }

  private async names(tx: Tx, ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const rows = await tx
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .where(inArray(users.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async folder(tx: Tx, ctx: Ctx, id: string, library?: ContentLibrary) {
    const [f] = await tx
      .select()
      .from(contentFolders)
      .where(
        and(
          eq(contentFolders.id, id),
          eq(contentFolders.tenantId, ctx.tenantId),
          isNull(contentFolders.deletedAt),
        ),
      );
    if (!f || (library && f.library !== library)) throw notFound('thư mục');
    return f;
  }

  private async asset(tx: Tx, ctx: Ctx, id: string): Promise<AssetRow> {
    const [a] = await tx
      .select()
      .from(contentAssets)
      .where(and(eq(contentAssets.id, id), eq(contentAssets.tenantId, ctx.tenantId)));
    if (!a) throw notFound('nội dung gốc');
    return a;
  }

  private async item(tx: Tx, ctx: Ctx, id: string, lock = false): Promise<ItemRow> {
    const q = tx
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.id, id), eq(contentItems.tenantId, ctx.tenantId)));
    const [i] = lock ? await q.for('update') : await q;
    if (!i) throw notFound('thành phẩm');
    return i;
  }

  private log(
    tx: Tx,
    ctx: Ctx,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType,
      targetId,
      metadata,
      ip: ctx.ip,
    });
  }
}

function editable(item: ItemRow): void {
  if (item.status === 'published')
    throw badState('Nội dung đã xuất bản không sửa được. Tạo thành phẩm mới nếu cần thay đổi.');
  if (item.status === 'archived') throw badState('Nội dung đã lưu trữ');
}

function duplicateName(e: unknown): unknown {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === '23505'
    ? new ConflictException({ code: 'CONTENT_FOLDER_EXISTS', message: 'Đã có thư mục cùng tên' })
    : e;
}

const fileInfo = (
  name: string | null,
  mime: string | null,
  size: number | null,
  hash: string | null,
): FileInfo | null =>
  name && mime && size !== null && hash ? { name, mime, sizeBytes: size, sha256: hash } : null;

function assetResponse(r: AssetRow, names: Map<string, string>, usedBy: number): AssetResponse {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    description: r.description,
    body: r.body,
    product: r.product,
    file: r.storageKey ? fileInfo(r.fileName, r.mime, r.sizeBytes, r.contentSha256) : null,
    folderId: r.folderId,
    source: r.source,
    sourceRef: r.sourceRef,
    rightsStatus: r.rightsStatus,
    rightsHolder: r.rightsHolder,
    rightsNote: r.rightsNote,
    rightsExpiresAt: r.rightsExpiresAt?.toISOString() ?? null,
    usable: rightsUsable(r.rightsStatus, r.rightsExpiresAt),
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    verifiedByName: r.verifiedBy ? (names.get(r.verifiedBy) ?? null) : null,
    tags: r.tags,
    usedBy,
    createdByName: names.get(r.createdBy) ?? '',
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    archivedAt: r.archivedAt?.toISOString() ?? null,
  };
}

function itemResponse(r: ItemRow, names: Map<string, string>): ItemResponse {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    language: r.language,
    market: r.market,
    platform: r.platform,
    status: r.status,
    folderId: r.folderId,
    tags: r.tags,
    currentVersion: r.currentVersion,
    reviewNote: r.reviewNote,
    reviewedByName: r.reviewedBy ? (names.get(r.reviewedBy) ?? null) : null,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    publishedUrl: r.publishedUrl,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    variantOf: r.variantOf,
    createdByName: names.get(r.createdBy) ?? '',
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function generationResponse(
  g: GenerationRow,
  names: Map<string, string>,
  progress: string | null,
  costUsd: number,
): GenerationResponse {
  return {
    id: g.id,
    mode: g.mode,
    status: g.status,
    progress,
    taskId: g.taskId,
    fromItemId: g.fromItemId,
    fromVersion: g.fromVersion,
    productAssetIds: g.productAssetIds,
    sourceAssetIds: g.sourceAssetIds,
    brief: g.brief,
    tone: g.tone,
    version: g.version,
    warnings: g.warnings,
    costUsd,
    errorCode: g.errorCode,
    errorMessage: g.errorMessage,
    createdByName: names.get(g.createdBy) ?? '',
    createdAt: g.createdAt.toISOString(),
    finishedAt: g.finishedAt?.toISOString() ?? null,
  };
}

function versionResponse(
  v: VersionRow,
  sources: Map<string, AssetRow>,
  skills: Map<string, string>,
  names: Map<string, string>,
  aiWarnings: string[] = [],
): VersionResponse {
  return {
    id: v.id,
    version: v.version,
    body: v.body,
    file: v.storageKey ? fileInfo(v.fileName, v.mime, v.sizeBytes, v.sha256) : null,
    sources: v.sourceAssetIds.flatMap((id) => {
      const s = sources.get(id);
      return s
        ? [
            {
              id: s.id,
              title: s.title,
              kind: s.kind,
              rightsStatus: s.rightsStatus,
              usable: rightsUsable(s.rightsStatus, s.rightsExpiresAt),
            },
          ]
        : [];
    }),
    skillId: v.skillId,
    skillName: v.skillId ? (skills.get(v.skillId) ?? null) : null,
    workflowRunId: v.workflowRunId,
    aiTaskId: v.aiTaskId,
    aiWarnings,
    workerJobId: v.workerJobId,
    note: v.note,
    createdByName: names.get(v.createdBy) ?? '',
    createdAt: v.createdAt.toISOString(),
  };
}
