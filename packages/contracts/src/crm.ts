import { z } from 'zod';
import { META_CHANNELS, type MetaChannel } from './meta';

/**
 * CRM (spec Part 20, M25) and Meta Lead Ads (Part 14). A contact is one customer, whatever
 * channel they came from; it moves through the sales pipeline and keeps a history that is only
 * added to. Leads from Lead Ads forms join the contact with the same phone number or email.
 */

export const CRM_STAGES = ['new', 'contacted', 'qualified', 'won', 'lost'] as const;
export type CrmStage = (typeof CRM_STAGES)[number];
export const CRM_STAGE_LABEL: Record<CrmStage, string> = {
  new: 'Mới',
  contacted: 'Đã liên hệ',
  qualified: 'Có nhu cầu',
  won: 'Đã mua',
  lost: 'Không mua',
};

export const CRM_SOURCES = ['manual', 'lead_ads', ...META_CHANNELS] as const;
export type CrmSource = (typeof CRM_SOURCES)[number];
export const CRM_SOURCE_LABEL: Record<CrmSource, string> = {
  manual: 'Nhập tay',
  lead_ads: 'Lead Ads',
  messenger: 'Messenger',
  ig_dm: 'Tin nhắn Instagram',
  fb_comment: 'Bình luận Facebook',
  ig_comment: 'Bình luận Instagram',
};

export type CrmActivityKind =
  'created' | 'note' | 'stage' | 'owner' | 'lead' | 'thread' | 'updated' | 'archived';

const phone = z
  .string()
  .trim()
  .max(40)
  .regex(/^[0-9+().\s-]*$/, 'Số điện thoại chỉ gồm chữ số, dấu cách, + - ( ) .')
  .refine((v) => v === '' || v.replace(/\D/g, '').length >= 6, 'Số điện thoại quá ngắn');
const email = z.union([z.literal(''), z.email('Email không đúng dạng').max(200)]);
const tags = z.array(z.string().trim().min(1).max(40)).max(20);

export const createContactSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: phone.optional(),
  email: email.optional(),
  stage: z.enum(CRM_STAGES).default('new'),
  ownerId: z.uuid().nullable().optional(),
  tags: tags.default([]),
  note: z.string().max(4000).default(''),
  valueVnd: z.number().int().min(0).max(1e13).nullable().optional(),
});
export type CreateContact = z.infer<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    phone: phone.optional(),
    email: email.optional(),
    stage: z.enum(CRM_STAGES).optional(),
    lostReason: z.string().trim().max(300).optional(),
    ownerId: z.uuid().nullable().optional(),
    tags: tags.optional(),
    note: z.string().max(4000).optional(),
    valueVnd: z.number().int().min(0).max(1e13).nullable().optional(),
    archived: z.literal(true).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Không có gì để đổi',
  });
export type UpdateContact = z.infer<typeof updateContactSchema>;

export const addNoteSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export type AddNote = z.infer<typeof addNoteSchema>;

/** Saves an inbox conversation's customer to the CRM: as a new contact, or onto one that exists. */
export const linkThreadSchema = z.object({ contactId: z.uuid().optional() });
export type LinkThread = z.infer<typeof linkThreadSchema>;

export const listContactsSchema = z.object({
  stage: z.enum(CRM_STAGES).optional(),
  source: z.enum(CRM_SOURCES).optional(),
  /** "me": owned by the person asking; "none": no owner; or a member's id. */
  owner: z.union([z.enum(['me', 'none']), z.uuid()]).optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListContacts = z.infer<typeof listContactsSchema>;

export const listLeadsSchema = z.object({
  formId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListLeads = z.infer<typeof listLeadsSchema>;

export const updateLeadFormSchema = z.object({ enabled: z.boolean() });
export type UpdateLeadForm = z.infer<typeof updateLeadFormSchema>;

export interface ContactResponse {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  stage: CrmStage;
  source: CrmSource;
  ownerId: string | null;
  ownerName: string | null;
  tags: string[];
  valueVnd: number | null;
  lastActivityAt: string;
  createdAt: string;
  archived: boolean;
}

export interface CrmActivityResponse {
  id: string;
  kind: CrmActivityKind;
  body: string;
  data: Record<string, unknown>;
  actorName: string | null;
  createdAt: string;
}

export interface LeadField {
  name: string;
  values: string[];
}

export interface LeadResponse {
  id: string;
  formId: string;
  formName: string;
  pageName: string;
  /** The name, phone and email read from the answers. */
  name: string | null;
  phone: string | null;
  email: string | null;
  fields: LeadField[];
  adName: string | null;
  campaignName: string | null;
  isOrganic: boolean;
  platform: string | null;
  leadAt: string;
  receivedVia: 'webhook' | 'sync';
  contactId: string | null;
  contactName: string | null;
}

export interface ContactDetail extends ContactResponse {
  note: string;
  lostReason: string | null;
  activities: CrmActivityResponse[];
  leads: LeadResponse[];
  threads: {
    id: string;
    channel: MetaChannel;
    assetName: string;
    snippet: string;
    lastMessageAt: string;
  }[];
}

export interface LeadFormResponse {
  id: string;
  assetId: string;
  pageName: string;
  externalId: string;
  name: string;
  status: string;
  enabled: boolean;
  leads: number;
  lastLeadAt: string | null;
  syncedAt: string | null;
}

export interface CrmSummaryResponse {
  stages: Record<CrmStage, number>;
  total: number;
  mine: number;
  unassigned: number;
  leads7d: number;
  /** Lead Ads: whether the Facebook connection has the permissions it needs. */
  leadAds: {
    ready: boolean;
    missingScopes: string[];
    forms: number;
    pollMinutes: number;
    lastSyncedAt: string | null;
  };
}
