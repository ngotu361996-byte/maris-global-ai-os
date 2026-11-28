import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import {
  CRM_STAGE_LABEL,
  CRM_STAGES,
  META_FEATURES,
  type AddNote,
  type ContactDetail,
  type ContactResponse,
  type CreateContact,
  type CrmActivityResponse,
  type CrmStage,
  type CrmSummaryResponse,
  type LeadFormResponse,
  type LeadResponse,
  type LinkThread,
  type ListContacts,
  type ListLeads,
  type UpdateContact,
  type UpdateLeadForm,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { DbService, type Tx } from '../db/db.service';
import { MetaLeadsService } from '../meta/meta-leads.service';
import {
  addActivity,
  contactOf,
  findDuplicate,
  lockContacts,
  matchOrCreate,
  normEmail,
  normPhone,
  type ContactRow,
} from './contacts-core';

const {
  crmContacts,
  crmActivities,
  metaAssets,
  metaConnections,
  metaLeadForms,
  metaLeads,
  metaThreads,
  tenantMembers,
  users,
} = schema;
type LeadRow = typeof metaLeads.$inferSelect;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const LEAD_SCOPES = META_FEATURES.find((f) => f.key === 'leads')!.scopes as readonly string[];

/**
 * CRM (spec Part 20, M25): one list of customers from every channel, a sales pipeline, owners,
 * notes and a history that is only added to. Contacts come from Lead Ads (MetaLeadsService), from
 * inbox conversations saved by staff, or typed in. A phone number or email belongs to one open
 * contact, so the same customer is not entered twice.
 */
@Injectable()
export class CrmService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly leads: MetaLeadsService,
  ) {}

  // ---------------------------------------------------------------------------------- summary

  async summary(ctx: Ctx): Promise<CrmSummaryResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select({ stage: crmContacts.stage, n: sql<number>`count(*)::int` })
        .from(crmContacts)
        .where(and(eq(crmContacts.tenantId, ctx.tenantId), isNull(crmContacts.archivedAt)))
        .groupBy(crmContacts.stage);
      const stages = Object.fromEntries(CRM_STAGES.map((s) => [s, 0])) as Record<CrmStage, number>;
      for (const r of rows) stages[r.stage] = r.n;
      const [own] = await tx
        .select({
          mine: sql<number>`count(*) FILTER (WHERE ${crmContacts.ownerId} = ${ctx.userId})::int`,
          unassigned: sql<number>`count(*) FILTER (WHERE ${crmContacts.ownerId} IS NULL AND ${crmContacts.stage} NOT IN ('won', 'lost'))::int`,
        })
        .from(crmContacts)
        .where(and(eq(crmContacts.tenantId, ctx.tenantId), isNull(crmContacts.archivedAt)));
      const [recent] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(metaLeads)
        .where(
          and(
            eq(metaLeads.tenantId, ctx.tenantId),
            gt(metaLeads.leadAt, sql`now() - interval '7 days'`),
          ),
        );
      const [conn] = await tx
        .select()
        .from(metaConnections)
        .where(
          and(eq(metaConnections.tenantId, ctx.tenantId), ne(metaConnections.status, 'removed')),
        );
      const scopes = conn?.status === 'active' ? conn.scopes : [];
      const missing = LEAD_SCOPES.filter((s) => !scopes.includes(s));
      const [forms] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(metaLeadForms)
        .where(eq(metaLeadForms.tenantId, ctx.tenantId));
      const [synced] = await tx
        .select({ at: sql<Date | null>`max(${metaAssets.leadsSyncedAt})` })
        .from(metaAssets)
        .where(eq(metaAssets.tenantId, ctx.tenantId));
      return {
        stages,
        total: Object.values(stages).reduce((a, b) => a + b, 0),
        mine: own?.mine ?? 0,
        unassigned: own?.unassigned ?? 0,
        leads7d: recent?.n ?? 0,
        leadAds: {
          ready: !!conn && conn.status === 'active' && missing.length === 0,
          missingScopes: missing,
          forms: forms?.n ?? 0,
          pollMinutes: this.config.META_LEADS_POLL_MIN,
          lastSyncedAt: synced?.at ? new Date(synced.at).toISOString() : null,
        },
      };
    });
  }

  // ---------------------------------------------------------------------------------- contacts

  async list(ctx: Ctx, f: ListContacts): Promise<ContactResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const q = f.q ? `%${escapeLike(f.q)}%` : null;
      const qDigits = f.q ? normPhone(f.q) : null;
      const rows = await tx
        .select({ c: crmContacts, owner: users.displayName })
        .from(crmContacts)
        .leftJoin(users, eq(users.id, crmContacts.ownerId))
        .where(
          and(
            eq(crmContacts.tenantId, ctx.tenantId),
            isNull(crmContacts.archivedAt),
            f.stage ? eq(crmContacts.stage, f.stage) : undefined,
            f.source ? eq(crmContacts.source, f.source) : undefined,
            f.owner === 'me' ? eq(crmContacts.ownerId, ctx.userId) : undefined,
            f.owner === 'none' ? isNull(crmContacts.ownerId) : undefined,
            f.owner && f.owner !== 'me' && f.owner !== 'none'
              ? eq(crmContacts.ownerId, f.owner)
              : undefined,
            q
              ? or(
                  ilike(crmContacts.name, q),
                  ilike(crmContacts.email, q),
                  ilike(crmContacts.note, q),
                  sql`array_to_string(${crmContacts.tags}, ' ') ILIKE ${q}`,
                  qDigits ? sql`${crmContacts.phoneNorm} LIKE ${`%${qDigits}%`}` : undefined,
                )
              : undefined,
          ),
        )
        .orderBy(desc(crmContacts.lastActivityAt), desc(crmContacts.id))
        .limit(300);
      return rows.map((r) => contactResponse(r.c, r.owner));
    });
  }

  async create(ctx: Ctx, input: CreateContact): Promise<ContactDetail> {
    return this.db.withContext(ctx, async (tx) => {
      await lockContacts(tx, ctx.tenantId);
      const phoneNorm = normPhone(input.phone);
      const emailNorm = normEmail(input.email);
      await this.assertNoDuplicate(tx, ctx.tenantId, phoneNorm, emailNorm);
      if (input.ownerId) await this.assertMember(tx, ctx.tenantId, input.ownerId);
      const id = uuidv7();
      await tx.insert(crmContacts).values({
        id,
        tenantId: ctx.tenantId,
        name: input.name,
        phone: phoneNorm ? input.phone! : null,
        phoneNorm,
        email: emailNorm ? input.email! : null,
        emailNorm,
        stage: input.stage,
        source: 'manual',
        ownerId: input.ownerId ?? null,
        tags: uniq(input.tags),
        note: input.note,
        valueVnd: input.valueVnd ?? null,
        createdBy: ctx.userId,
      });
      await addActivity(tx, {
        tenantId: ctx.tenantId,
        contactId: id,
        kind: 'created',
        data: { source: 'manual' },
        actorId: ctx.userId,
      });
      await this.log(tx, ctx, 'crm.contact_created', id, { source: 'manual', stage: input.stage });
      return this.detailIn(tx, ctx.tenantId, id);
    });
  }

  async detail(ctx: Ctx, id: string): Promise<ContactDetail> {
    return this.db.withContext(ctx, (tx) => this.detailIn(tx, ctx.tenantId, id));
  }

  async update(ctx: Ctx, id: string, patch: UpdateContact): Promise<ContactDetail> {
    return this.db.withContext(ctx, async (tx) => {
      await lockContacts(tx, ctx.tenantId);
      const c = await this.contact(tx, ctx.tenantId, id);
      if (c.archivedAt)
        throw new ConflictException({
          code: 'CRM_CONTACT_ARCHIVED',
          message: 'Khách hàng này đã được lưu trữ',
        });
      const set: Partial<ContactRow> = { updatedAt: new Date() };
      const changed: string[] = [];
      if (patch.name !== undefined && patch.name !== c.name) {
        set.name = patch.name;
        changed.push('name');
      }
      if (patch.phone !== undefined) {
        const phoneNorm = normPhone(patch.phone);
        if (phoneNorm !== c.phoneNorm || (patch.phone || null) !== c.phone) {
          if (phoneNorm) await this.assertNoDuplicate(tx, ctx.tenantId, phoneNorm, null, id);
          set.phone = phoneNorm ? patch.phone : null;
          set.phoneNorm = phoneNorm;
          changed.push('phone');
        }
      }
      if (patch.email !== undefined) {
        const emailNorm = normEmail(patch.email);
        if (emailNorm !== c.emailNorm) {
          if (emailNorm) await this.assertNoDuplicate(tx, ctx.tenantId, null, emailNorm, id);
          set.email = emailNorm ? patch.email : null;
          set.emailNorm = emailNorm;
          changed.push('email');
        }
      }
      if (patch.tags !== undefined) {
        set.tags = uniq(patch.tags);
        changed.push('tags');
      }
      if (patch.note !== undefined && patch.note !== c.note) {
        set.note = patch.note;
        changed.push('note');
      }
      if (patch.valueVnd !== undefined && patch.valueVnd !== c.valueVnd) {
        set.valueVnd = patch.valueVnd;
        changed.push('valueVnd');
      }
      if (patch.stage !== undefined && patch.stage !== c.stage) {
        set.stage = patch.stage;
        set.lostReason = patch.stage === 'lost' ? patch.lostReason || null : null;
      } else if (patch.lostReason !== undefined && c.stage === 'lost') {
        set.lostReason = patch.lostReason || null;
        changed.push('lostReason');
      }
      if (patch.ownerId !== undefined && patch.ownerId !== c.ownerId) {
        if (patch.ownerId) await this.assertMember(tx, ctx.tenantId, patch.ownerId);
        set.ownerId = patch.ownerId;
      }
      if (patch.archived) set.archivedAt = new Date();
      await tx.update(crmContacts).set(set).where(eq(crmContacts.id, id));

      const base = { tenantId: ctx.tenantId, contactId: id, actorId: ctx.userId };
      if (set.stage)
        await addActivity(tx, {
          ...base,
          kind: 'stage',
          body: `${CRM_STAGE_LABEL[c.stage]} → ${CRM_STAGE_LABEL[set.stage]}${set.lostReason ? `: ${set.lostReason}` : ''}`,
          data: { from: c.stage, to: set.stage },
        });
      if (set.ownerId !== undefined) {
        const [u] = set.ownerId
          ? await tx
              .select({ name: users.displayName })
              .from(users)
              .where(eq(users.id, set.ownerId))
          : [];
        await addActivity(tx, {
          ...base,
          kind: 'owner',
          body: u ? `Giao cho ${u.name}` : 'Bỏ người phụ trách',
          data: { from: c.ownerId, to: set.ownerId },
        });
      }
      if (changed.length)
        await addActivity(tx, { ...base, kind: 'updated', body: '', data: { fields: changed } });
      if (patch.archived) await addActivity(tx, { ...base, kind: 'archived' });
      // Field names only: customer data stays out of the audit log.
      await this.log(tx, ctx, patch.archived ? 'crm.contact_archived' : 'crm.contact_updated', id, {
        fields: changed,
        ...(set.stage ? { stage: { from: c.stage, to: set.stage } } : {}),
        ...(set.ownerId !== undefined ? { owner: { from: c.ownerId, to: set.ownerId } } : {}),
      });
      return this.detailIn(tx, ctx.tenantId, id);
    });
  }

  async addNote(ctx: Ctx, id: string, input: AddNote): Promise<ContactDetail> {
    return this.db.withContext(ctx, async (tx) => {
      const c = await this.contact(tx, ctx.tenantId, id);
      if (c.archivedAt)
        throw new ConflictException({
          code: 'CRM_CONTACT_ARCHIVED',
          message: 'Khách hàng này đã được lưu trữ',
        });
      await addActivity(tx, {
        tenantId: ctx.tenantId,
        contactId: id,
        kind: 'note',
        body: input.body,
        actorId: ctx.userId,
      });
      await this.log(tx, ctx, 'crm.note_added', id, { chars: input.body.length });
      return this.detailIn(tx, ctx.tenantId, id);
    });
  }

  /** Saves an inbox conversation's customer to the CRM: onto a chosen contact, or a new one. */
  async linkThread(ctx: Ctx, threadId: string, input: LinkThread): Promise<ContactDetail> {
    return this.db.withContext(ctx, async (tx) => {
      const [t] = await tx
        .select({ t: metaThreads, asset: metaAssets })
        .from(metaThreads)
        .innerJoin(metaAssets, eq(metaAssets.id, metaThreads.assetId))
        .where(and(eq(metaThreads.id, threadId), eq(metaThreads.tenantId, ctx.tenantId)));
      if (!t)
        throw new NotFoundException({
          code: 'INBOX_THREAD_NOT_FOUND',
          message: 'Không tìm thấy hội thoại',
        });
      await lockContacts(tx, ctx.tenantId);
      let contactId: string;
      let created = false;
      if (input.contactId) {
        const c = await this.contact(tx, ctx.tenantId, input.contactId);
        if (c.archivedAt)
          throw new ConflictException({
            code: 'CRM_CONTACT_ARCHIVED',
            message: 'Khách hàng này đã được lưu trữ',
          });
        contactId = c.id;
      } else if (t.t.contactId) {
        return this.detailIn(tx, ctx.tenantId, t.t.contactId);
      } else {
        const r = await matchOrCreate(tx, {
          tenantId: ctx.tenantId,
          name: t.t.customerName,
          phone: null,
          email: null,
          source: t.t.channel,
          actorId: ctx.userId,
          fallbackName: 'Khách',
        });
        contactId = r.contact.id;
        created = r.created;
        if (created)
          await tx
            .update(crmContacts)
            .set({ ownerId: t.t.assignedTo })
            .where(eq(crmContacts.id, contactId));
      }
      if (t.t.contactId === contactId) return this.detailIn(tx, ctx.tenantId, contactId);
      await tx.update(metaThreads).set({ contactId }).where(eq(metaThreads.id, threadId));
      const asset =
        t.asset.kind === 'instagram' && t.asset.username ? `@${t.asset.username}` : t.asset.name;
      await addActivity(tx, {
        tenantId: ctx.tenantId,
        contactId,
        kind: 'thread',
        body: `Gắn hội thoại ${channelLabel(t.t.channel)} với ${asset}`,
        data: { threadId, channel: t.t.channel, from: t.t.contactId },
        actorId: ctx.userId,
      });
      await this.log(tx, ctx, 'crm.thread_linked', contactId, {
        threadId,
        newContact: created,
        from: t.t.contactId,
      });
      return this.detailIn(tx, ctx.tenantId, contactId);
    });
  }

  // ---------------------------------------------------------------------------------- Lead Ads

  async leadsList(ctx: Ctx, f: ListLeads): Promise<LeadResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const q = f.q ? `%${escapeLike(f.q)}%` : null;
      return this.leadRows(
        tx,
        and(
          eq(metaLeads.tenantId, ctx.tenantId),
          f.formId ? eq(metaLeads.formId, f.formId) : undefined,
          q
            ? or(
                sql`${metaLeads.fields}::text ILIKE ${q}`,
                ilike(metaLeads.adName, q),
                ilike(metaLeads.campaignName, q),
              )
            : undefined,
        ),
        300,
      );
    });
  }

  async forms(ctx: Ctx): Promise<LeadFormResponse[]> {
    return this.db.withContext(ctx, (tx) => this.formsIn(tx, ctx.tenantId));
  }

  async updateForm(ctx: Ctx, id: string, input: UpdateLeadForm): Promise<LeadFormResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const [f] = await tx
        .update(metaLeadForms)
        .set({ enabled: input.enabled })
        .where(and(eq(metaLeadForms.id, id), eq(metaLeadForms.tenantId, ctx.tenantId)))
        .returning();
      if (!f)
        throw new NotFoundException({
          code: 'CRM_FORM_NOT_FOUND',
          message: 'Không tìm thấy biểu mẫu',
        });
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'crm.lead_form_updated',
        targetType: 'meta_lead_form',
        targetId: id,
        metadata: { enabled: input.enabled },
        ip: ctx.ip,
      });
      return this.formsIn(tx, ctx.tenantId);
    });
  }

  /** "Đọc lead ngay": reads the forms and new leads of every enabled Page now. */
  async syncLeads(ctx: Ctx): Promise<CrmSummaryResponse & { added: number }> {
    const added = await this.leads.syncTenant({ tenantId: ctx.tenantId, userId: ctx.userId }, true);
    await this.db.withContext(ctx, (tx) =>
      this.log(tx, ctx, 'crm.leads_synced', null, { added }, 'tenant', ctx.tenantId),
    );
    return { ...(await this.summary(ctx)), added };
  }

  // ---------------------------------------------------------------------------------- helpers

  private async formsIn(tx: Tx, tenantId: string): Promise<LeadFormResponse[]> {
    const rows = await tx
      .select({
        f: metaLeadForms,
        page: metaAssets.name,
        n: sql<number>`(SELECT count(*)::int FROM meta.leads l WHERE l.form_id = ${metaLeadForms.id})`,
      })
      .from(metaLeadForms)
      .innerJoin(metaAssets, eq(metaAssets.id, metaLeadForms.assetId))
      .where(eq(metaLeadForms.tenantId, tenantId))
      .orderBy(sql`${metaLeadForms.lastLeadAt} DESC NULLS LAST`, asc(metaLeadForms.id))
      .limit(200);
    return rows.map(({ f, page, n }) => ({
      id: f.id,
      assetId: f.assetId,
      pageName: page,
      externalId: f.externalId,
      name: f.name,
      status: f.status,
      enabled: f.enabled,
      leads: n,
      lastLeadAt: f.lastLeadAt?.toISOString() ?? null,
      syncedAt: f.syncedAt?.toISOString() ?? null,
    }));
  }

  private async leadRows(
    tx: Tx,
    where: ReturnType<typeof and>,
    limit: number,
  ): Promise<LeadResponse[]> {
    const rows = await tx
      .select({
        l: metaLeads,
        form: metaLeadForms.name,
        page: metaAssets.name,
        contact: crmContacts.name,
      })
      .from(metaLeads)
      .innerJoin(metaLeadForms, eq(metaLeadForms.id, metaLeads.formId))
      .innerJoin(metaAssets, eq(metaAssets.id, metaLeads.assetId))
      .leftJoin(crmContacts, eq(crmContacts.id, metaLeads.contactId))
      .where(where)
      .orderBy(desc(metaLeads.leadAt), desc(metaLeads.id))
      .limit(limit);
    return rows.map((r) => leadResponse(r.l, r.form, r.page, r.contact));
  }

  private async detailIn(tx: Tx, tenantId: string, id: string): Promise<ContactDetail> {
    const [r] = await tx
      .select({ c: crmContacts, owner: users.displayName })
      .from(crmContacts)
      .leftJoin(users, eq(users.id, crmContacts.ownerId))
      .where(and(eq(crmContacts.id, id), eq(crmContacts.tenantId, tenantId)));
    if (!r) throw notFound();
    const acts = await tx
      .select({ a: crmActivities, by: users.displayName })
      .from(crmActivities)
      .leftJoin(users, eq(users.id, crmActivities.actorId))
      .where(eq(crmActivities.contactId, id))
      .orderBy(desc(crmActivities.createdAt), desc(crmActivities.id))
      .limit(200);
    const leads = await this.leadRows(
      tx,
      and(eq(metaLeads.tenantId, tenantId), eq(metaLeads.contactId, id)),
      50,
    );
    const threads = await tx
      .select({ t: metaThreads, asset: metaAssets })
      .from(metaThreads)
      .innerJoin(metaAssets, eq(metaAssets.id, metaThreads.assetId))
      .where(and(eq(metaThreads.tenantId, tenantId), eq(metaThreads.contactId, id)))
      .orderBy(desc(metaThreads.lastMessageAt))
      .limit(50);
    return {
      ...contactResponse(r.c, r.owner),
      note: r.c.note,
      lostReason: r.c.lostReason,
      activities: acts.map(({ a, by }): CrmActivityResponse => ({
        id: a.id,
        kind: a.kind,
        body: a.body,
        data: a.data,
        actorName: by,
        createdAt: a.createdAt.toISOString(),
      })),
      leads,
      threads: threads.map(({ t, asset }) => ({
        id: t.id,
        channel: t.channel,
        assetName: asset.kind === 'instagram' && asset.username ? `@${asset.username}` : asset.name,
        snippet: t.snippet,
        lastMessageAt: t.lastMessageAt.toISOString(),
      })),
    };
  }

  private async contact(tx: Tx, tenantId: string, id: string): Promise<ContactRow> {
    const [c] = await tx
      .select()
      .from(crmContacts)
      .where(and(eq(crmContacts.id, id), eq(crmContacts.tenantId, tenantId)));
    if (!c) throw notFound();
    return c;
  }

  private async assertNoDuplicate(
    tx: Tx,
    tenantId: string,
    phoneNorm: string | null,
    emailNorm: string | null,
    exceptId?: string,
  ): Promise<void> {
    const dup = await findDuplicate(tx, tenantId, phoneNorm, emailNorm, exceptId);
    if (dup)
      throw new ConflictException({
        code: 'CRM_DUPLICATE',
        message: `Đã có khách hàng “${dup.name}” với ${phoneNorm && dup.phoneNorm === phoneNorm ? 'số điện thoại' : 'email'} này`,
        details: { contactId: dup.id },
      });
  }

  private async assertMember(tx: Tx, tenantId: string, userId: string): Promise<void> {
    const [m] = await tx
      .select()
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId)));
    if (!m)
      throw new BadRequestException({
        code: 'MEMBER_NOT_FOUND',
        message: 'Người này không thuộc doanh nghiệp',
      });
  }

  private log(
    tx: Tx,
    ctx: Ctx,
    action: string,
    targetId: string | null,
    metadata: Record<string, unknown>,
    targetType = 'crm_contact',
    target: string | null = targetId,
  ) {
    return this.audit.append(tx, {
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      action,
      targetType,
      targetId: target,
      metadata,
      ip: ctx.ip,
    });
  }
}

const notFound = () =>
  new NotFoundException({ code: 'CRM_CONTACT_NOT_FOUND', message: 'Không tìm thấy khách hàng' });

const uniq = (tags: string[]) => [...new Set(tags.map((t) => t.trim()).filter(Boolean))];

const channelLabel = (c: string) =>
  ({
    messenger: 'Messenger',
    ig_dm: 'tin nhắn Instagram',
    fb_comment: 'bình luận Facebook',
    ig_comment: 'bình luận Instagram',
  })[c] ?? c;

function contactResponse(c: ContactRow, owner: string | null): ContactResponse {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    stage: c.stage,
    source: c.source,
    ownerId: c.ownerId,
    ownerName: c.ownerId ? owner : null,
    tags: c.tags,
    valueVnd: c.valueVnd,
    lastActivityAt: c.lastActivityAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
    archived: !!c.archivedAt,
  };
}

function leadResponse(
  l: LeadRow,
  form: string,
  page: string,
  contact: string | null,
): LeadResponse {
  const who = contactOf(l.fields);
  return {
    id: l.id,
    formId: l.formId,
    formName: form,
    pageName: page,
    name: who.name,
    phone: who.phone,
    email: who.email,
    fields: l.fields,
    adName: l.adName,
    campaignName: l.campaignName,
    isOrganic: l.isOrganic,
    platform: l.platform,
    leadAt: l.leadAt.toISOString(),
    receivedVia: l.receivedVia,
    contactId: l.contactId,
    contactName: l.contactId ? contact : null,
  };
}
