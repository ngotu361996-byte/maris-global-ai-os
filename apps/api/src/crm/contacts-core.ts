import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import type { CrmActivityKind, CrmSource, LeadField } from '@maris/contracts';
import type { Tx } from '../db/db.service';

const { crmContacts, crmActivities } = schema;
export type ContactRow = typeof crmContacts.$inferSelect;

/**
 * Digits only, so "+84 912 345 678", "0912.345.678" and "84912345678" are the same customer.
 * Vietnamese numbers in the international form become the usual 0xxxxxxxxx.
 */
export function normPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('0084')) d = d.slice(2);
  if (d.startsWith('84') && (d.length === 11 || d.length === 12)) d = `0${d.slice(2)}`;
  if (d.length < 6) return null;
  return d.slice(0, 20);
}

export function normEmail(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  return v && v.includes('@') ? v.slice(0, 200) : null;
}

const pick = (fields: LeadField[], names: string[]) => {
  for (const n of names) {
    const f = fields.find((x) => x.name.toLowerCase() === n);
    const v = f?.values.find((s) => s.trim());
    if (v) return v.trim();
  }
  return null;
};

/** The name, phone and email in a Lead Ads form's answers (Meta's standard question names). */
export function contactOf(fields: LeadField[]): {
  name: string | null;
  phone: string | null;
  email: string | null;
} {
  const full =
    pick(fields, ['full_name', 'name', 'ho_ten', 'họ_tên']) ??
    ([pick(fields, ['first_name']), pick(fields, ['last_name'])].filter(Boolean).join(' ') || null);
  return {
    name: full?.slice(0, 200) ?? null,
    phone:
      pick(fields, ['phone_number', 'phone', 'so_dien_thoai', 'số_điện_thoại'])?.slice(0, 40) ??
      null,
    email: pick(fields, ['email', 'work_email'])?.slice(0, 200) ?? null,
  };
}

/** Serialises contact matching per tenant, so two leads of one person make one contact. */
export async function lockContacts(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`crm-contacts:${tenantId}`}))`);
}

/** The open contact with this phone number or email, if any. */
export async function findDuplicate(
  tx: Tx,
  tenantId: string,
  phoneNorm: string | null,
  emailNorm: string | null,
  exceptId?: string,
): Promise<ContactRow | null> {
  if (!phoneNorm && !emailNorm) return null;
  const rows = await tx
    .select()
    .from(crmContacts)
    .where(
      and(
        eq(crmContacts.tenantId, tenantId),
        isNull(crmContacts.archivedAt),
        or(
          phoneNorm ? eq(crmContacts.phoneNorm, phoneNorm) : undefined,
          emailNorm ? eq(crmContacts.emailNorm, emailNorm) : undefined,
        ),
      ),
    )
    .limit(3);
  // A phone number match counts before an email match.
  const others = rows.filter((r) => r.id !== exceptId);
  return others.find((r) => phoneNorm && r.phoneNorm === phoneNorm) ?? others[0] ?? null;
}

export async function addActivity(
  tx: Tx,
  a: {
    tenantId: string;
    contactId: string;
    kind: CrmActivityKind;
    body?: string;
    data?: Record<string, unknown>;
    actorId: string | null;
  },
): Promise<void> {
  await tx.insert(crmActivities).values({
    id: uuidv7(),
    tenantId: a.tenantId,
    contactId: a.contactId,
    kind: a.kind,
    body: (a.body ?? '').slice(0, 4000),
    data: a.data ?? {},
    actorId: a.actorId,
  });
  await tx
    .update(crmContacts)
    .set({ lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(crmContacts.id, a.contactId));
}

/**
 * The contact for a customer who reached the business: the one with the same phone number or
 * email, filled in where it lacked them, or a new one. Call with lockContacts held.
 */
export async function matchOrCreate(
  tx: Tx,
  c: {
    tenantId: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    source: CrmSource;
    actorId: string | null;
    fallbackName: string;
  },
): Promise<{ contact: ContactRow; created: boolean }> {
  const phoneNorm = normPhone(c.phone);
  const emailNorm = normEmail(c.email);
  const found = await findDuplicate(tx, c.tenantId, phoneNorm, emailNorm);
  if (found) {
    const fill: Partial<ContactRow> = {};
    if (!found.phoneNorm && phoneNorm && c.phone) {
      // Only if no other contact has the number.
      if (!(await findDuplicate(tx, c.tenantId, phoneNorm, null, found.id)))
        Object.assign(fill, { phone: c.phone, phoneNorm });
    }
    if (!found.emailNorm && emailNorm && c.email) {
      if (!(await findDuplicate(tx, c.tenantId, null, emailNorm, found.id)))
        Object.assign(fill, { email: c.email, emailNorm });
    }
    if (Object.keys(fill).length) {
      const [u] = await tx
        .update(crmContacts)
        .set({ ...fill, updatedAt: new Date() })
        .where(eq(crmContacts.id, found.id))
        .returning();
      return { contact: u!, created: false };
    }
    return { contact: found, created: false };
  }
  const [row] = await tx
    .insert(crmContacts)
    .values({
      id: uuidv7(),
      tenantId: c.tenantId,
      name: (c.name || c.fallbackName).slice(0, 200),
      phone: phoneNorm ? c.phone : null,
      phoneNorm,
      email: emailNorm ? c.email : null,
      emailNorm,
      source: c.source,
      createdBy: c.actorId,
    })
    .returning();
  await addActivity(tx, {
    tenantId: c.tenantId,
    contactId: row!.id,
    kind: 'created',
    data: { source: c.source },
    actorId: c.actorId,
  });
  return { contact: row!, created: true };
}
