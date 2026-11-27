import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  MARIS_VERSION,
  PLUGIN_SAMPLES,
  satisfiesRange,
  type ActivatePlugin,
  type AddPublisher,
  type InstallPlugin,
  type PluginCheck,
  type PluginComponentKind,
  type PluginComponentResponse,
  type PluginManifest,
  type PluginResponse,
  type PluginSample,
  type PluginSignatureStatus,
  type PluginVersionResponse,
  type PublisherResponse,
  type RevokePlugin,
} from '@maris/contracts';
import {
  assertChecksum,
  assertPublicKey,
  keyFingerprint,
  parsePlugin,
  PluginFileError,
  verifyPluginSignature,
} from '@maris/sdk';
import type { Ctx } from '../ai/chat.service';
import { SkillsService } from '../ai/skills.service';
import { AuditService } from '../audit/audit.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { DbService, type Tx } from '../db/db.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { runPluginTests } from './plugin-tests';

const {
  plugins,
  pluginVersions,
  pluginComponents,
  trustedPublishers,
  aiSkills,
  connectors,
  workflowDefinitions,
} = schema;
type PluginRow = typeof plugins.$inferSelect;
type ComponentRow = typeof pluginComponents.$inferSelect;

const bad = (code: string, message: string) => new BadRequestException({ code, message });

/**
 * Plugin Center (spec Part 23). A plugin is a signed bundle of declarative parts: skills,
 * connectors and workflows. Installing runs the same checks as importing each part, plus the
 * plugin's own: checksum, signature, permissions, budget and timeout limits, and its tests. Every
 * part arrives off. Activation (ai.approve) checks again (signature against the keys trusted now,
 * dependencies, compatibility, secrets, tests) and then turns every part on. No code from a plugin
 * runs here, so a plugin cannot reach the database or anything its parts do not declare.
 */
@Injectable()
export class PluginsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly skills: SkillsService,
    private readonly workflows: WorkflowsService,
    private readonly connectors: ConnectorsService,
  ) {}

  samples(): readonly PluginSample[] {
    return PLUGIN_SAMPLES;
  }

  list(ctx: Ctx): Promise<PluginResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(plugins)
        .where(and(eq(plugins.tenantId, ctx.tenantId), isNull(plugins.deletedAt)))
        .orderBy(plugins.name);
      return Promise.all(rows.map((r) => this.respond(tx, r)));
    });
  }

  get(ctx: Ctx, id: string): Promise<PluginResponse> {
    return this.db.withContext(ctx, async (tx) =>
      this.respond(tx, await this.row(tx, ctx.tenantId, id)),
    );
  }

  /** Installs a plugin file, or updates the installed plugin with the same key when `replace`. */
  install(ctx: Ctx, body: InstallPlugin): Promise<PluginResponse> {
    const m = this.parse(body.manifest);
    return this.db.withContext(ctx, async (tx) => {
      const row = await this.installIn(tx, ctx, m, body.replace ?? false, null);
      return this.respond(tx, row);
    });
  }

  /** Puts an earlier installed version back. Like an update, it leaves every part off. */
  restoreVersion(ctx: Ctx, id: string, versionId: string): Promise<PluginResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      const [v] = await tx
        .select()
        .from(pluginVersions)
        .where(and(eq(pluginVersions.id, versionId), eq(pluginVersions.pluginId, id)));
      if (!v)
        throw new NotFoundException({
          code: 'PLUGIN_VERSION_NOT_FOUND',
          message: 'Không tìm thấy phiên bản này',
        });
      const row = await this.installIn(
        tx,
        ctx,
        this.parse(v.manifest),
        true,
        `khôi phục phiên bản ${v.version} từ ${current.version}`,
      );
      return this.respond(tx, row);
    });
  }

  /** Checks everything again, then turns every part on. Needs ai.approve (see the controller). */
  activate(ctx: Ctx, id: string, body: ActivatePlugin): Promise<PluginResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      if (current.status === 'revoked')
        throw bad('PLUGIN_REVOKED', 'Plugin đã bị thu hồi; gỡ rồi cài bản an toàn');
      const m = current.manifest as unknown as PluginManifest;
      const allowUnsigned = body.allowUnsigned ?? false;
      const checks = await this.checks(tx, current, allowUnsigned);
      const failed = checks.filter((c) => !c.ok);
      if (failed.length)
        throw bad(
          'PLUGIN_CHECK_FAILED',
          `Chưa bật được: ${failed.map((c) => `${c.label} (${c.detail})`).join('; ')}`,
        );
      const parts = await this.componentRows(tx, current.id);
      for (const p of parts.filter((x) => x.kind === 'skill'))
        await this.skills.setStatusIn(tx, ctx, p.componentId, 'active');
      for (const p of parts.filter((x) => x.kind === 'connector'))
        await this.connectors.activateIn(tx, ctx, p.componentId);
      for (const p of parts.filter((x) => x.kind === 'workflow'))
        await this.workflows.setStatusIn(tx, ctx, p.componentId, 'active');
      const sig = await this.signatureOf(tx, ctx.tenantId, m);
      const [row] = await tx
        .update(plugins)
        .set({
          status: 'active',
          signatureStatus: sig.status === 'invalid' ? current.signatureStatus : sig.status,
          activatedBy: ctx.userId,
          activatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(plugins.id, id))
        .returning();
      await this.log(tx, ctx, 'plugin.activated', id, {
        key: current.key,
        version: current.version,
        checksum: current.checksum,
        signature: current.signatureStatus,
        allowUnsigned: allowUnsigned && current.signatureStatus !== 'trusted',
        permissions: m.permissions,
      });
      return this.respond(tx, row!);
    });
  }

  pause(ctx: Ctx, id: string): Promise<PluginResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      if (current.status !== 'active') return this.respond(tx, current);
      await this.pauseParts(tx, ctx, current.id);
      const [row] = await tx
        .update(plugins)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(eq(plugins.id, id))
        .returning();
      await this.log(tx, ctx, 'plugin.paused', id, { key: current.key });
      return this.respond(tx, row!);
    });
  }

  /** Turns an unsafe plugin off for good: it cannot be activated again, only removed. */
  revoke(ctx: Ctx, id: string, body: RevokePlugin): Promise<PluginResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      await this.pauseParts(tx, ctx, current.id);
      const [row] = await tx
        .update(plugins)
        .set({ status: 'revoked', revokedReason: body.reason, updatedAt: new Date() })
        .where(eq(plugins.id, id))
        .returning();
      await this.log(tx, ctx, 'plugin.revoked', id, {
        key: current.key,
        version: current.version,
        reason: body.reason,
      });
      return this.respond(tx, row!);
    });
  }

  /** Removes the plugin and every part it installed. Refused while another plugin needs it. */
  remove(ctx: Ctx, id: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      const current = await this.row(tx, ctx.tenantId, id);
      const others = await this.rows(tx, ctx.tenantId);
      const users = others.filter(
        (o) =>
          o.id !== id &&
          (o.manifest as unknown as PluginManifest).dependencies.some((d) => d.key === current.key),
      );
      if (users.length)
        throw new ConflictException({
          code: 'PLUGIN_REQUIRED',
          message: `Plugin khác đang cần Plugin này: ${users.map((u) => u.name).join(', ')}`,
        });
      for (const p of await this.componentRows(tx, id)) await this.removePart(tx, ctx, p);
      await tx.delete(pluginComponents).where(eq(pluginComponents.pluginId, id));
      await tx
        .update(plugins)
        .set({ deletedAt: new Date(), status: 'paused', updatedAt: new Date() })
        .where(eq(plugins.id, id));
      await this.log(tx, ctx, 'plugin.removed', id, {
        key: current.key,
        version: current.version,
      });
    });
  }

  versions(ctx: Ctx, id: string): Promise<PluginVersionResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      await this.row(tx, ctx.tenantId, id);
      const rows = await tx
        .select()
        .from(pluginVersions)
        .where(eq(pluginVersions.pluginId, id))
        .orderBy(desc(pluginVersions.createdAt));
      return rows.map((v) => ({
        id: v.id,
        version: v.version,
        checksum: v.checksum,
        signatureStatus: v.signatureStatus,
        createdAt: v.createdAt.toISOString(),
      }));
    });
  }

  /** The file as installed, with its signature, so it can be moved to another workspace. */
  export(ctx: Ctx, id: string): Promise<PluginManifest> {
    return this.db.withContext(ctx, async (tx) => {
      const row = await this.row(tx, ctx.tenantId, id);
      await this.log(tx, ctx, 'plugin.exported', id, { key: row.key, version: row.version });
      return row.manifest as unknown as PluginManifest;
    });
  }

  publishers(ctx: Ctx): Promise<PublisherResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(trustedPublishers)
        .where(
          and(eq(trustedPublishers.tenantId, ctx.tenantId), isNull(trustedPublishers.revokedAt)),
        )
        .orderBy(trustedPublishers.name);
      return rows.map(publisherResponse);
    });
  }

  /** Trusting a key lets plugins it signed be activated without the unsigned override. */
  addPublisher(ctx: Ctx, body: AddPublisher): Promise<PublisherResponse> {
    try {
      assertPublicKey(body.publicKey);
    } catch (e) {
      throw bad('PUBLISHER_KEY_INVALID', (e as Error).message);
    }
    return this.db.withContext(ctx, async (tx) => {
      const [dup] = await tx
        .select({ id: trustedPublishers.id })
        .from(trustedPublishers)
        .where(
          and(
            eq(trustedPublishers.tenantId, ctx.tenantId),
            eq(trustedPublishers.keyId, body.keyId),
            isNull(trustedPublishers.revokedAt),
          ),
        );
      if (dup)
        throw new ConflictException({
          code: 'PUBLISHER_EXISTS',
          message: `Đã có khóa mã "${body.keyId}"`,
        });
      const [row] = await tx
        .insert(trustedPublishers)
        .values({
          id: uuidv7(),
          tenantId: ctx.tenantId,
          keyId: body.keyId,
          name: body.name,
          publicKey: body.publicKey.trim(),
          addedBy: ctx.userId,
        })
        .returning();
      const res = publisherResponse(row!);
      // Plugins already installed with this key now count as trusted, if the signature holds.
      for (const r of await this.rows(tx, ctx.tenantId)) {
        if (r.signerKeyId !== body.keyId || r.signatureStatus === 'trusted') continue;
        const ok = verifyPluginSignature(r.manifest as unknown as PluginManifest, row!.publicKey);
        if (ok)
          await tx
            .update(plugins)
            .set({ signatureStatus: 'trusted', updatedAt: new Date() })
            .where(eq(plugins.id, r.id));
      }
      await this.log(tx, ctx, 'plugin.publisher_trusted', row!.id, {
        keyId: body.keyId,
        name: body.name,
        fingerprint: res.fingerprint,
      });
      return res;
    });
  }

  /**
   * Stops trusting a key. Plugins it signed count as signed by an unknown key from now on, and
   * the ones that are on are paused, so someone decides again whether to keep them.
   */
  revokePublisher(ctx: Ctx, publisherId: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      const [p] = await tx
        .select()
        .from(trustedPublishers)
        .where(
          and(
            eq(trustedPublishers.id, publisherId),
            eq(trustedPublishers.tenantId, ctx.tenantId),
            isNull(trustedPublishers.revokedAt),
          ),
        );
      if (!p)
        throw new NotFoundException({
          code: 'PUBLISHER_NOT_FOUND',
          message: 'Không tìm thấy nhà phát hành',
        });
      await tx
        .update(trustedPublishers)
        .set({ revokedAt: new Date() })
        .where(eq(trustedPublishers.id, publisherId));
      const signed = (await this.rows(tx, ctx.tenantId)).filter((r) => r.signerKeyId === p.keyId);
      for (const r of signed) {
        if (r.status === 'active') await this.pauseParts(tx, ctx, r.id);
        await tx
          .update(plugins)
          .set({
            signatureStatus: 'untrusted',
            status: r.status === 'active' ? 'paused' : r.status,
            updatedAt: new Date(),
          })
          .where(eq(plugins.id, r.id));
      }
      await this.log(tx, ctx, 'plugin.publisher_revoked', publisherId, {
        keyId: p.keyId,
        pausedPlugins: signed.filter((r) => r.status === 'active').map((r) => r.key),
      });
    });
  }

  // ---------------------------------------------------------------------------------------------

  private parse(input: unknown): PluginManifest {
    try {
      const m = parsePlugin(input);
      return { ...m, checksum: assertChecksum(m) };
    } catch (e) {
      if (e instanceof PluginFileError) throw bad(e.code, e.message);
      throw e;
    }
  }

  private async installIn(
    tx: Tx,
    ctx: Ctx,
    m: PluginManifest,
    replace: boolean,
    note: string | null,
  ): Promise<PluginRow> {
    const signature = await this.signatureOf(tx, ctx.tenantId, m);
    if (signature.status === 'invalid')
      throw bad(
        'PLUGIN_SIGNATURE_INVALID',
        `Chữ ký của khóa "${m.signature!.keyId}" không khớp nội dung tệp: tệp đã bị sửa hoặc ký sai`,
      );
    const failed = runPluginTests(m).filter((t) => !t.ok);
    if (failed.length)
      throw bad(
        'PLUGIN_TEST_FAILED',
        `Bài kiểm tra không đạt: ${failed.map((t) => `${t.name} (${t.detail})`).join('; ')}`,
      );

    const [existing] = await tx
      .select()
      .from(plugins)
      .where(
        and(eq(plugins.tenantId, ctx.tenantId), eq(plugins.key, m.key), isNull(plugins.deletedAt)),
      );
    if (existing && !replace)
      throw new ConflictException({
        code: 'PLUGIN_EXISTS',
        message: `Đã cài Plugin "${m.key}" (phiên bản ${existing.version}). Chọn cập nhật nếu muốn thay.`,
      });
    if (existing?.status === 'revoked')
      throw bad('PLUGIN_REVOKED', 'Plugin này đã bị thu hồi; gỡ nó trước khi cài lại');

    const owned = existing ? await this.componentRows(tx, existing.id) : [];
    const ownedKey = (kind: PluginComponentKind, key: string) =>
      owned.find((o) => o.kind === kind && o.key === key);
    await this.assertNoConflicts(tx, ctx.tenantId, m, owned);

    // Everything is off until activation, and parts the new file drops go away.
    if (existing) await this.pauseParts(tx, ctx, existing.id);
    const keep = new Set([
      ...m.contents.skills.map((s) => `skill:${s.key}`),
      ...m.contents.connectors.map((c) => `connector:${c.key}`),
      ...m.contents.workflows.map((w) => `workflow:${w.key}`),
    ]);
    for (const o of owned) if (!keep.has(`${o.kind}:${o.key}`)) await this.removePart(tx, ctx, o);

    const parts: { kind: PluginComponentKind; key: string; id: string }[] = [];
    for (const s of m.contents.skills) {
      const r = await this.skills.importIn(tx, ctx, s, !!ownedKey('skill', s.key));
      parts.push({ kind: 'skill', key: s.key, id: r.id });
    }
    for (const c of m.contents.connectors) {
      const r = await this.connectors.importIn(tx, ctx, c, !!ownedKey('connector', c.key));
      parts.push({ kind: 'connector', key: c.key, id: r.id });
    }
    for (const w of m.contents.workflows) {
      const { row } = await this.workflows.importIn(tx, ctx, w, !!ownedKey('workflow', w.key));
      parts.push({ kind: 'workflow', key: w.key, id: row.id });
    }

    const values = {
      key: m.key,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author,
      status: 'installed' as const,
      manifest: m as unknown as Record<string, unknown>,
      checksum: m.checksum!,
      signatureStatus: signature.status,
      signerKeyId: m.signature?.keyId ?? null,
      activatedBy: null,
      activatedAt: null,
      revokedReason: null,
      updatedAt: new Date(),
    };
    let row: PluginRow;
    if (existing) {
      [row] = (await tx
        .update(plugins)
        .set(values)
        .where(eq(plugins.id, existing.id))
        .returning()) as [PluginRow];
      await tx.delete(pluginComponents).where(eq(pluginComponents.pluginId, row.id));
    } else {
      [row] = (await tx
        .insert(plugins)
        .values({ ...values, id: uuidv7(), tenantId: ctx.tenantId, installedBy: ctx.userId })
        .returning()) as [PluginRow];
    }
    if (parts.length)
      await tx.insert(pluginComponents).values(
        parts.map((p) => ({
          tenantId: ctx.tenantId,
          pluginId: row.id,
          kind: p.kind,
          key: p.key,
          componentId: p.id,
        })),
      );
    await tx.insert(pluginVersions).values({
      id: uuidv7(),
      tenantId: ctx.tenantId,
      pluginId: row.id,
      version: m.version,
      manifest: values.manifest,
      checksum: m.checksum!,
      signatureStatus: signature.status,
      installedBy: ctx.userId,
    });
    await this.log(tx, ctx, existing ? 'plugin.updated' : 'plugin.installed', row.id, {
      key: m.key,
      version: m.version,
      ...(existing && { from: existing.version }),
      ...(note && { note }),
      checksum: m.checksum,
      signature: signature.status,
      signerKeyId: m.signature?.keyId ?? null,
      permissions: m.permissions,
      parts: parts.map((p) => `${p.kind}:${p.key}`),
    });
    return row;
  }

  /** A part's key may already be used only by this same plugin. */
  private async assertNoConflicts(
    tx: Tx,
    tenantId: string,
    m: PluginManifest,
    owned: ComponentRow[],
  ): Promise<void> {
    const taken: string[] = [];
    const check = async (
      kind: PluginComponentKind,
      label: string,
      keys: string[],
      found: (keys: string[]) => Promise<{ key: string; id: string }[]>,
    ) => {
      if (!keys.length) return;
      for (const f of await found(keys))
        if (!owned.some((o) => o.kind === kind && o.componentId === f.id))
          taken.push(`${label} "${f.key}"`);
    };
    await check(
      'skill',
      'Skill',
      m.contents.skills.map((s) => s.key),
      (keys) =>
        tx
          .select({ key: aiSkills.key, id: aiSkills.id })
          .from(aiSkills)
          .where(
            and(
              eq(aiSkills.tenantId, tenantId),
              inArray(aiSkills.key, keys),
              isNull(aiSkills.deletedAt),
            ),
          ),
    );
    await check(
      'connector',
      'Connector',
      m.contents.connectors.map((c) => c.key),
      (keys) =>
        tx
          .select({ key: connectors.key, id: connectors.id })
          .from(connectors)
          .where(
            and(
              eq(connectors.tenantId, tenantId),
              inArray(connectors.key, keys),
              isNull(connectors.deletedAt),
            ),
          ),
    );
    await check(
      'workflow',
      'Workflow',
      m.contents.workflows.map((w) => w.key),
      (keys) =>
        tx
          .select({ key: workflowDefinitions.key, id: workflowDefinitions.id })
          .from(workflowDefinitions)
          .where(
            and(
              eq(workflowDefinitions.tenantId, tenantId),
              inArray(workflowDefinitions.key, keys),
              isNull(workflowDefinitions.deletedAt),
            ),
          ),
    );
    if (taken.length)
      throw new ConflictException({
        code: 'PLUGIN_COMPONENT_CONFLICT',
        message: `Đã có sẵn, không thuộc Plugin này: ${taken.join(', ')}. Đổi mã hoặc xóa bản cũ trước.`,
      });
  }

  /** trusted, untrusted (unknown key), unsigned, or invalid (a known key that did not sign this). */
  private async signatureOf(
    tx: Tx,
    tenantId: string,
    m: PluginManifest,
  ): Promise<{ status: PluginSignatureStatus | 'invalid' }> {
    if (!m.signature) return { status: 'unsigned' };
    const [key] = await tx
      .select()
      .from(trustedPublishers)
      .where(
        and(
          eq(trustedPublishers.tenantId, tenantId),
          eq(trustedPublishers.keyId, m.signature.keyId),
          isNull(trustedPublishers.revokedAt),
        ),
      );
    if (!key) return { status: 'untrusted' };
    return { status: verifyPluginSignature(m, key.publicKey) ? 'trusted' : 'invalid' };
  }

  /** What activation requires, checked against the workspace as it is now. */
  private async checks(tx: Tx, row: PluginRow, allowUnsigned: boolean): Promise<PluginCheck[]> {
    const m = row.manifest as unknown as PluginManifest;
    const out: PluginCheck[] = [];
    const add = (key: string, label: string, ok: boolean, detail: string) =>
      out.push({ key, label, ok, detail });

    let sumOk = true;
    try {
      sumOk = assertChecksum(parsePlugin(m)) === row.checksum;
    } catch {
      sumOk = false;
    }
    add('checksum', 'Toàn vẹn tệp', sumOk, sumOk ? 'Checksum khớp' : 'Checksum không khớp');

    const sig = await this.signatureOf(tx, row.tenantId, m);
    const sigOk = sig.status === 'trusted' || (sig.status !== 'invalid' && allowUnsigned);
    add(
      'signature',
      'Chữ ký',
      sigOk,
      sig.status === 'trusted'
        ? `Ký bởi khóa tin cậy "${m.signature!.keyId}"`
        : sig.status === 'invalid'
          ? 'Chữ ký không khớp nội dung'
          : allowUnsigned
            ? 'Chưa có chữ ký tin cậy; người bật đã chấp nhận'
            : sig.status === 'untrusted'
              ? `Khóa "${m.signature!.keyId}" chưa được tin cậy; thêm khóa hoặc chọn chấp nhận Plugin chưa ký`
              : 'Chưa ký; chọn chấp nhận Plugin chưa ký nếu bạn tin nguồn của tệp',
    );

    const compatible = satisfiesRange(MARIS_VERSION, m.compatibility.maris);
    add(
      'compatibility',
      'Tương thích',
      compatible,
      `Cần MARIS ${m.compatibility.maris}, đang chạy ${MARIS_VERSION}`,
    );

    if (m.dependencies.length) {
      const installed = await this.rows(tx, row.tenantId);
      const problems = m.dependencies.flatMap((d) => {
        const p = installed.find((x) => x.key === d.key);
        if (!p) return [`chưa cài "${d.key}"`];
        if (!satisfiesRange(p.version, d.version))
          return [`"${d.key}" phiên bản ${p.version}, cần ${d.version}`];
        if (p.status !== 'active') return [`"${d.key}" chưa bật`];
        return [];
      });
      add(
        'dependencies',
        'Phụ thuộc',
        !problems.length,
        problems.length ? problems.join(', ') : m.dependencies.map((d) => d.key).join(', '),
      );
    }

    const parts = await this.componentRows(tx, row.id);
    const gone = (await this.components(tx, row.id)).filter((c) => c.status === 'deleted');
    add(
      'parts',
      'Thành phần',
      !gone.length,
      gone.length
        ? `Đã bị xóa: ${gone.map((c) => c.key).join(', ')}; cài lại Plugin để có lại`
        : `${parts.length} thành phần có đủ`,
    );
    const missingSecrets: string[] = [];
    for (const p of parts.filter((x) => x.kind === 'connector')) {
      const [c] = await tx
        .select()
        .from(connectors)
        .where(and(eq(connectors.id, p.componentId), isNull(connectors.deletedAt)));
      if (c) missingSecrets.push(...(await this.connectors.missingSecretsOf(tx, c)));
    }
    if (parts.some((x) => x.kind === 'connector'))
      add(
        'secrets',
        'Secret Vault',
        !missingSecrets.length,
        missingSecrets.length
          ? `Thiếu: ${[...new Set(missingSecrets)].join(', ')}`
          : 'Đủ secret cho các Connector',
      );

    const tests = runPluginTests(m);
    const failed = tests.filter((t) => !t.ok);
    add(
      'tests',
      'Bài kiểm tra',
      !failed.length,
      failed.length
        ? failed.map((t) => t.name).join(', ')
        : `${tests.length}/${tests.length} bài đạt`,
    );
    return out;
  }

  private async pauseParts(tx: Tx, ctx: Ctx, pluginId: string): Promise<void> {
    for (const p of await this.componentRows(tx, pluginId)) {
      if (p.kind === 'skill') await this.skills.setStatusIn(tx, ctx, p.componentId, 'paused');
      if (p.kind === 'connector') await this.connectors.pauseIn(tx, ctx, p.componentId);
      if (p.kind === 'workflow') await this.workflows.setStatusIn(tx, ctx, p.componentId, 'paused');
    }
  }

  /** Deletes a part unless someone already deleted it by hand. */
  private async removePart(tx: Tx, ctx: Ctx, p: ComponentRow): Promise<void> {
    try {
      if (p.kind === 'skill') await this.skills.removeIn(tx, ctx, p.componentId);
      if (p.kind === 'connector') await this.connectors.removeIn(tx, ctx, p.componentId);
      if (p.kind === 'workflow') await this.workflows.removeIn(tx, ctx, p.componentId);
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
    }
  }

  private componentRows(tx: Tx, pluginId: string): Promise<ComponentRow[]> {
    return tx.select().from(pluginComponents).where(eq(pluginComponents.pluginId, pluginId));
  }

  private rows(tx: Tx, tenantId: string): Promise<PluginRow[]> {
    return tx
      .select()
      .from(plugins)
      .where(and(eq(plugins.tenantId, tenantId), isNull(plugins.deletedAt)));
  }

  private async row(tx: Tx, tenantId: string, id: string): Promise<PluginRow> {
    const [row] = await tx
      .select()
      .from(plugins)
      .where(and(eq(plugins.id, id), eq(plugins.tenantId, tenantId), isNull(plugins.deletedAt)));
    if (!row)
      throw new NotFoundException({ code: 'PLUGIN_NOT_FOUND', message: 'Không tìm thấy Plugin' });
    return row;
  }

  private async components(tx: Tx, pluginId: string): Promise<PluginComponentResponse[]> {
    const parts = await this.componentRows(tx, pluginId);
    const ids = (kind: PluginComponentKind) =>
      parts.filter((p) => p.kind === kind).map((p) => p.componentId);
    const found: { id: string; name: string; status: string; deletedAt: Date | null }[] = [];
    if (ids('skill').length)
      found.push(
        ...(await tx
          .select({
            id: aiSkills.id,
            name: aiSkills.name,
            status: aiSkills.status,
            deletedAt: aiSkills.deletedAt,
          })
          .from(aiSkills)
          .where(inArray(aiSkills.id, ids('skill')))),
      );
    if (ids('connector').length)
      found.push(
        ...(await tx
          .select({
            id: connectors.id,
            name: connectors.name,
            status: connectors.status,
            deletedAt: connectors.deletedAt,
          })
          .from(connectors)
          .where(inArray(connectors.id, ids('connector')))),
      );
    if (ids('workflow').length)
      found.push(
        ...(await tx
          .select({
            id: workflowDefinitions.id,
            name: workflowDefinitions.name,
            status: workflowDefinitions.status,
            deletedAt: workflowDefinitions.deletedAt,
          })
          .from(workflowDefinitions)
          .where(inArray(workflowDefinitions.id, ids('workflow')))),
      );
    const order: PluginComponentKind[] = ['skill', 'connector', 'workflow'];
    return parts
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.key.localeCompare(b.key))
      .map((p) => {
        const f = found.find((x) => x.id === p.componentId);
        return {
          kind: p.kind,
          key: p.key,
          id: p.componentId,
          name: f?.name ?? p.key,
          status: !f || f.deletedAt ? 'deleted' : f.status,
        };
      });
  }

  private async respond(tx: Tx, r: PluginRow): Promise<PluginResponse> {
    const m = r.manifest as unknown as PluginManifest;
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      version: r.version,
      description: r.description,
      author: r.author,
      homepage: m.homepage ?? null,
      status: r.status,
      permissions: m.permissions,
      dependencies: m.dependencies,
      compatibility: m.compatibility,
      resources: m.resources,
      timeoutSec: m.timeoutSec,
      checksum: r.checksum,
      signatureStatus: r.signatureStatus,
      signerKeyId: r.signerKeyId,
      components: await this.components(tx, r.id),
      checks: r.status === 'revoked' ? [] : await this.checks(tx, r, false),
      tests: runPluginTests(m),
      activatedBy: r.activatedBy,
      activatedAt: r.activatedAt?.toISOString() ?? null,
      revokedReason: r.revokedReason,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private log(tx: Tx, ctx: Ctx, action: string, id: string, metadata?: Record<string, unknown>) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType: 'plugin',
      targetId: id,
      metadata,
      ip: ctx.ip,
    });
  }
}

function publisherResponse(r: typeof trustedPublishers.$inferSelect): PublisherResponse {
  return {
    id: r.id,
    keyId: r.keyId,
    name: r.name,
    fingerprint: keyFingerprint(r.publicKey),
    createdAt: r.createdAt.toISOString(),
  };
}
