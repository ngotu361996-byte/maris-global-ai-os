import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import type { LeadField } from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { addActivity, contactOf, lockContacts, matchOrCreate } from '../crm/contacts-core';
import { DbService, type Tx } from '../db/db.service';
import type { LeadRef } from './inbox-events';
import { timeOf } from './inbox-events';
import { MetaGraphService, type GraphCtx } from './meta-graph.service';

const { metaApps, metaAssets, metaConnections, metaLeadForms, metaLeads } = schema;
type AssetRow = typeof metaAssets.$inferSelect;
type FormRow = typeof metaLeadForms.$inferSelect;

const TICK_MS = 60_000;
/** Pages read per tenant per tick (round robin, spec Part 15). */
const POLL_PAGES_PER_TICK = 1;
/** While the webhook delivers, leads still get read, this many times less often (a safety net). */
const WEBHOOK_SLOWDOWN = 4;
const WEBHOOK_FRESH_MS = 60 * 60_000;
/** Pages of 50 leads read per form per read. */
const MAX_LEAD_PAGES = 10;
const LEAD_FIELDS =
  'id,created_time,field_data,ad_id,ad_name,campaign_id,campaign_name,form_id,is_organic,platform';

/** One lead as Meta gives it (GET /{form}/leads or GET /{leadgen-id}). */
export interface GraphLead {
  id?: string;
  created_time?: string;
  field_data?: { name?: string; values?: unknown[] }[];
  ad_id?: string;
  ad_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  is_organic?: boolean;
  platform?: string;
}

const digits = (v: unknown): string | null =>
  typeof v === 'string' && /^[0-9]{1,30}$/.test(v) ? v : null;
const clip = (v: unknown, n: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null;

/** The answers of a lead, cleaned: at most 50 questions, 10 values each, 1,000 characters a value. */
export function leadFields(raw: GraphLead['field_data']): LeadField[] {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, 50)
    .map((f) => ({
      name: String(f?.name ?? '').slice(0, 100),
      values: (Array.isArray(f?.values) ? f.values : [])
        .slice(0, 10)
        .map((v) => String(v ?? '').slice(0, 1000)),
    }))
    .filter((f) => f.name);
}

/**
 * Meta Lead Ads (spec Part 14): reads the forms of each enabled Page and their leads, and takes
 * leads that the webhook names. Every lead is stored once and joined to a CRM contact with the
 * same phone number or email, or to a new contact. Calls go through the API Governor: reading is
 * group "sync" in the background, a lead from the webhook is group "lookup".
 */
@Injectable()
export class MetaLeadsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MetaLeadsService.name);
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbService,
    private readonly graph: MetaGraphService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!this.config.META_LEADS_POLL_MIN) return;
    this.timer = setInterval(() => void this.pollOnce().catch((e) => this.log.error(e)), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---------------------------------------------------------------------------------- webhook

  /** Leads named by a webhook delivery: read each one's answers from Meta and store it. */
  async fromWebhook(tenantId: string, refs: LeadRef[]): Promise<number> {
    let n = 0;
    for (const ref of refs) {
      try {
        const page = await this.db.withContext({ tenantId }, async (tx) => {
          const [p] = await tx
            .select()
            .from(metaAssets)
            .where(
              and(
                eq(metaAssets.tenantId, tenantId),
                eq(metaAssets.kind, 'page'),
                eq(metaAssets.externalId, ref.pageId),
                isNull(metaAssets.removedAt),
              ),
            );
          return p?.enabled ? p : null;
        });
        if (!page) continue;
        const ctx: GraphCtx = { tenantId, userId: null };
        const lead = await this.graph.call<GraphLead>(ctx, {
          group: 'lookup',
          priority: 'normal',
          method: 'GET',
          path: `/${ref.leadgenId}`,
          params: { fields: LEAD_FIELDS },
          auth: { kind: 'page', assetId: page.id },
          assetId: page.id,
        });
        const formExt = digits(lead.form_id) ?? ref.formId;
        if (!formExt) continue;
        const form = await this.formFor(ctx, page, formExt);
        if (!form?.enabled) continue;
        if (await this.store(tenantId, form, page, lead, 'webhook')) n++;
      } catch (e) {
        // The next read of the form picks it up.
        this.log.warn(`lead ${ref.leadgenId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return n;
  }

  /** The form row for a Meta form id, created (with its name from Meta) the first time it is seen. */
  private async formFor(
    ctx: GraphCtx,
    page: AssetRow,
    externalId: string,
  ): Promise<FormRow | null> {
    const [known] = await this.db.withContext(ctx, (tx) =>
      tx
        .select()
        .from(metaLeadForms)
        .where(
          and(eq(metaLeadForms.tenantId, ctx.tenantId), eq(metaLeadForms.externalId, externalId)),
        ),
    );
    if (known) return known;
    let name = `Biểu mẫu ${externalId}`;
    let status = 'ACTIVE';
    try {
      const f = await this.graph.call<{ name?: string; status?: string }>(ctx, {
        group: 'lookup',
        priority: 'normal',
        method: 'GET',
        path: `/${externalId}`,
        params: { fields: 'id,name,status' },
        auth: { kind: 'page', assetId: page.id },
        assetId: page.id,
        cacheSec: 3600,
      });
      name = clip(f.name, 300) ?? name;
      status = clip(f.status, 40) ?? status;
    } catch {
      // A name is nice to have.
    }
    return this.db.withContext(ctx, (tx) =>
      this.upsertForm(tx, ctx.tenantId, page.id, externalId, name, status),
    );
  }

  private async upsertForm(
    tx: Tx,
    tenantId: string,
    assetId: string,
    externalId: string,
    name: string,
    status: string,
  ): Promise<FormRow> {
    const [row] = await tx
      .insert(metaLeadForms)
      .values({ id: uuidv7(), tenantId, assetId, externalId, name, status })
      .onConflictDoUpdate({
        target: [metaLeadForms.tenantId, metaLeadForms.externalId],
        set: { name, status, assetId },
      })
      .returning();
    return row!;
  }

  // ---------------------------------------------------------------------------------- storing

  /** Stores one lead and joins it to a contact. Returns false when it was already there. */
  private async store(
    tenantId: string,
    form: FormRow,
    page: AssetRow,
    lead: GraphLead,
    via: 'webhook' | 'sync',
  ): Promise<boolean> {
    const externalId = digits(lead.id);
    if (!externalId) return false;
    const fields = leadFields(lead.field_data);
    const at = timeOf(lead.created_time);
    return this.db.withContext({ tenantId }, async (tx) => {
      const leadId = uuidv7();
      const [inserted] = await tx
        .insert(metaLeads)
        .values({
          id: leadId,
          tenantId,
          formId: form.id,
          assetId: page.id,
          externalId,
          fields,
          adId: digits(lead.ad_id),
          adName: clip(lead.ad_name, 300),
          campaignId: digits(lead.campaign_id),
          campaignName: clip(lead.campaign_name, 300),
          isOrganic: lead.is_organic === true,
          platform: clip(lead.platform, 20),
          leadAt: at,
          receivedVia: via,
        })
        .onConflictDoNothing()
        .returning({ id: metaLeads.id });
      await tx
        .update(metaLeadForms)
        .set({
          lastLeadAt: sql`GREATEST(COALESCE(${metaLeadForms.lastLeadAt}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)`,
        })
        .where(eq(metaLeadForms.id, form.id));
      if (!inserted) return false;

      await lockContacts(tx, tenantId);
      const who = contactOf(fields);
      const { contact, created } = await matchOrCreate(tx, {
        tenantId,
        ...who,
        source: 'lead_ads',
        actorId: null,
        fallbackName: `Lead ${form.name}`.slice(0, 200),
      });
      await tx.update(metaLeads).set({ contactId: contact.id }).where(eq(metaLeads.id, leadId));
      await addActivity(tx, {
        tenantId,
        contactId: contact.id,
        kind: 'lead',
        body: `Gửi biểu mẫu “${form.name}” trên ${page.name}`,
        data: {
          leadId,
          formId: form.id,
          adName: clip(lead.ad_name, 300),
          campaignName: clip(lead.campaign_name, 300),
        },
        actorId: null,
      });
      // Customer data (name, phone, email) stays out of the audit log.
      await this.audit.append(tx, {
        tenantId,
        actorUserId: null,
        action: 'crm.lead_received',
        targetType: 'crm_contact',
        targetId: contact.id,
        metadata: { leadId, formId: form.id, via, newContact: created },
      });
      return true;
    });
  }

  // ---------------------------------------------------------------------------------- reading

  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const tenants = await this.db.withSystem('meta_leads', (tx) =>
        tx
          .select({ tenantId: metaConnections.tenantId, userId: metaConnections.connectedBy })
          .from(metaConnections)
          .where(eq(metaConnections.status, 'active')),
      );
      let n = 0;
      for (const t of tenants) {
        try {
          n += await this.syncTenant({ tenantId: t.tenantId, userId: t.userId }, false);
        } catch (e) {
          this.log.warn(`leads poll ${t.tenantId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return n;
    } finally {
      this.polling = false;
    }
  }

  /** Reads forms and new leads: every enabled Page when asked by a person, else the next one due. */
  async syncTenant(ctx: GraphCtx, all: boolean): Promise<number> {
    const pages = await this.db.withContext(ctx, async (tx) => {
      const [app] = await tx.select().from(metaApps).where(eq(metaApps.tenantId, ctx.tenantId));
      if (!app) return [];
      const webhookFresh =
        !!app.webhookLastAt && Date.now() - app.webhookLastAt.getTime() < WEBHOOK_FRESH_MS;
      const minutes = this.config.META_LEADS_POLL_MIN * (webhookFresh ? WEBHOOK_SLOWDOWN : 1);
      return tx
        .select()
        .from(metaAssets)
        .where(
          and(
            eq(metaAssets.tenantId, ctx.tenantId),
            eq(metaAssets.kind, 'page'),
            eq(metaAssets.enabled, true),
            isNull(metaAssets.removedAt),
            all
              ? undefined
              : or(
                  isNull(metaAssets.leadsSyncedAt),
                  lt(metaAssets.leadsSyncedAt, new Date(Date.now() - minutes * 60_000)),
                ),
          ),
        )
        .orderBy(sql`${metaAssets.leadsSyncedAt} ASC NULLS FIRST`, asc(metaAssets.id))
        .limit(all ? 50 : POLL_PAGES_PER_TICK);
    });
    let n = 0;
    for (const page of pages) {
      try {
        n += await this.syncPage(ctx, page, all);
      } finally {
        await this.db.withContext(ctx, (tx) =>
          tx
            .update(metaAssets)
            .set({ leadsSyncedAt: new Date() })
            .where(eq(metaAssets.id, page.id)),
        );
      }
    }
    return n;
  }

  private async syncPage(ctx: GraphCtx, page: AssetRow, manual: boolean): Promise<number> {
    const call = <T>(path: string, params: Record<string, string | number>) =>
      this.graph.call<T>(ctx, {
        group: 'sync',
        priority: manual ? 'normal' : 'background',
        method: 'GET',
        path,
        params,
        auth: { kind: 'page', assetId: page.id },
        assetId: page.id,
      });
    const list = await call<{ data?: { id?: string; name?: string; status?: string }[] }>(
      `/${page.externalId}/leadgen_forms`,
      { fields: 'id,name,status', limit: 50 },
    );
    const forms = await this.db.withContext(ctx, async (tx) => {
      const out: FormRow[] = [];
      for (const f of list.data ?? []) {
        const id = digits(f.id);
        if (!id) continue;
        out.push(
          await this.upsertForm(
            tx,
            ctx.tenantId,
            page.id,
            id,
            clip(f.name, 300) ?? `Biểu mẫu ${id}`,
            clip(f.status, 40) ?? 'ACTIVE',
          ),
        );
      }
      return out;
    });

    let n = 0;
    for (const form of forms) {
      if (!form.enabled) continue;
      const params: Record<string, string | number> = { fields: LEAD_FIELDS, limit: 50 };
      if (form.lastLeadAt)
        params.filtering = JSON.stringify([
          {
            field: 'time_created',
            operator: 'GREATER_THAN',
            // A minute back, in case two leads share the last second; doubles are skipped.
            value: Math.floor(form.lastLeadAt.getTime() / 1000) - 60,
          },
        ]);
      const found: GraphLead[] = [];
      for (let i = 0; i < MAX_LEAD_PAGES; i++) {
        const r = await call<{
          data?: GraphLead[];
          paging?: { cursors?: { after?: string }; next?: string };
        }>(`/${form.externalId}/leads`, params);
        found.push(...(r.data ?? []));
        const after = r.paging?.next ? r.paging.cursors?.after : undefined;
        if (!after || !(r.data ?? []).length) break;
        params.after = after;
      }
      // Oldest first, so a contact's history reads in the order the leads came.
      found.sort((a, b) => timeOf(a.created_time).getTime() - timeOf(b.created_time).getTime());
      for (const lead of found) if (await this.store(ctx.tenantId, form, page, lead, 'sync')) n++;
      await this.db.withContext(ctx, (tx) =>
        tx.update(metaLeadForms).set({ syncedAt: new Date() }).where(eq(metaLeadForms.id, form.id)),
      );
    }
    return n;
  }
}
