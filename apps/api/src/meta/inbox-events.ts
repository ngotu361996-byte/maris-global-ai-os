import { createHash } from 'node:crypto';
import type { MetaChannel } from '@maris/contracts';

/** One comment or message, the same whether it came by webhook or by reading. */
export interface Inbound {
  channel: MetaChannel;
  /** The Page (Messenger, Facebook comments) or Instagram account (Instagram) it belongs to. */
  account: { kind: 'page' | 'instagram'; externalId: string };
  /** The customer's id for chats; the top-level comment's id for comments. */
  threadKey: string;
  /** The customer; null when the business wrote it and the customer is not known from it. */
  customer: { id: string; name: string | null } | null;
  postId: string | null;
  externalId: string;
  body: string;
  attachments: { type: string; url: string | null }[];
  at: Date;
  /** Written by the Page or Instagram account itself: an echo of a reply, or one sent elsewhere. */
  fromBusiness: boolean;
  authorName: string | null;
}

/** A Lead Ads lead named by the "leadgen" webhook: the answers themselves are read from Meta. */
export interface LeadRef {
  pageId: string;
  leadgenId: string;
  formId: string | null;
}

/** One change in a webhook delivery, with the key that makes it count once. */
export interface WebhookChange {
  key: string;
  object: string;
  field: string;
  inbound: Inbound | null;
  /** A new Lead Ads lead: MARIS reads its answers from Meta (Sprint 24). */
  lead: LeadRef | null;
  /** Why it was not taken, when it was not. */
  skipped: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Meta gives seconds, milliseconds or ISO text depending on the field. */
export function timeOf(v: unknown): Date {
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
  if (typeof v === 'string') {
    const d = new Date(/^\d+$/.test(v) ? Number(v) * (v.length > 12 ? 1 : 1000) : v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function attachmentsOf(v: unknown): Inbound['attachments'] {
  const list = Array.isArray(v) ? v : arr(obj(v).data);
  return list.slice(0, 10).map((a) => {
    const o = obj(a);
    const url =
      str(obj(o.payload).url) ?? str(obj(obj(o.image_data)).url) ?? str(o.file_url) ?? str(o.url);
    return {
      type: clip(str(o.type) ?? str(o.mime_type) ?? 'file', 40),
      url: url ? clip(url, 2000) : null,
    };
  });
}

/** A Messenger or Instagram message event (webhook "messaging" entry). */
function messagingEvent(object: string, accountId: string, m: Obj): Inbound | string {
  const message = obj(m.message);
  const mid = str(message.mid);
  if (!mid) return 'không phải tin nhắn (đã đọc, đã nhận, phản hồi nút)';
  if (message.is_deleted) return 'tin nhắn đã bị xóa';
  const sender = str(obj(m.sender).id);
  const recipient = str(obj(m.recipient).id);
  const fromBusiness = message.is_echo === true || sender === accountId;
  const customerId = fromBusiness ? recipient : sender;
  if (!customerId) return 'thiếu người gửi';
  return {
    channel: object === 'instagram' ? 'ig_dm' : 'messenger',
    account: { kind: object === 'instagram' ? 'instagram' : 'page', externalId: accountId },
    threadKey: customerId,
    customer: { id: customerId, name: null },
    postId: null,
    externalId: mid,
    body: clip(str(message.text) ?? '', 8000),
    attachments: attachmentsOf(message.attachments),
    at: timeOf(m.timestamp),
    fromBusiness,
    authorName: null,
  };
}

/** A Facebook Page "feed" change about a comment. */
function feedComment(pageId: string, v: Obj): Inbound | string {
  if (v.item !== 'comment') return `không phải bình luận (${clip(str(v.item) ?? '?', 30)})`;
  if (v.verb !== 'add') return `bình luận ${clip(str(v.verb) ?? '?', 20)}, không phải mới`;
  const id = str(v.comment_id);
  const postId = str(v.post_id);
  if (!id || !postId) return 'thiếu mã bình luận';
  const parent = str(v.parent_id);
  const from = obj(v.from);
  const fromId = str(from.id);
  const fromBusiness = fromId === pageId;
  return {
    channel: 'fb_comment',
    account: { kind: 'page', externalId: pageId },
    // A reply to a comment belongs to the top-level comment; the parent of a top-level one is the post.
    threadKey: parent && parent !== postId ? parent : id,
    customer: fromId && !fromBusiness ? { id: fromId, name: str(from.name) } : null,
    postId,
    externalId: id,
    body: clip(str(v.message) ?? '', 8000),
    attachments: v.photo ? [{ type: 'image', url: clip(String(v.photo), 2000) }] : [],
    at: timeOf(v.created_time),
    fromBusiness,
    authorName: str(from.name),
  };
}

/** An Instagram "comments" change. */
function igComment(igId: string, v: Obj): Inbound | string {
  const id = str(v.id);
  if (!id) return 'thiếu mã bình luận';
  const from = obj(v.from);
  const fromId = str(from.id);
  const fromBusiness = fromId === igId;
  const parent = str(v.parent_id);
  return {
    channel: 'ig_comment',
    account: { kind: 'instagram', externalId: igId },
    threadKey: parent ?? id,
    customer: fromId && !fromBusiness ? { id: fromId, name: str(from.username) } : null,
    postId: str(obj(v.media).id),
    externalId: id,
    body: clip(str(v.text) ?? '', 8000),
    attachments: [],
    at: timeOf(v.timestamp ?? v.created_time),
    fromBusiness,
    authorName: str(from.username),
  };
}

/** A Page "leadgen" change: someone sent a Lead Ads form. Only ids; no answers come with it. */
function leadgen(pageId: string, v: Obj): LeadRef | string {
  const leadgenId = str(v.leadgen_id);
  if (!leadgenId || !/^[0-9]{1,30}$/.test(leadgenId)) return 'thiếu mã lead';
  const formId = str(v.form_id);
  return {
    pageId: str(v.page_id) ?? pageId,
    leadgenId,
    formId: formId && /^[0-9]{1,30}$/.test(formId) ? formId : null,
  };
}

/** Splits a webhook delivery from Meta into its changes. Unknown shapes are kept as skipped. */
export function parseWebhook(body: unknown): WebhookChange[] {
  const root = obj(body);
  const object = clip(str(root.object) ?? 'unknown', 40);
  const out: WebhookChange[] = [];
  const push = (field: string, raw: unknown, r: Inbound | LeadRef | string) =>
    out.push({
      key: sha(`${object}:${field}:${JSON.stringify(raw)}`),
      object,
      field: clip(field, 40),
      inbound: typeof r === 'string' || 'leadgenId' in r ? null : r,
      lead: typeof r !== 'string' && 'leadgenId' in r ? r : null,
      skipped: typeof r === 'string' ? clip(r, 300) : null,
    });
  for (const e of arr(root.entry).slice(0, 100)) {
    const entry = obj(e);
    const accountId = str(entry.id);
    if (!accountId) continue;
    for (const m of arr(entry.messaging).slice(0, 100))
      push('messages', m, messagingEvent(object, accountId, obj(m)));
    for (const c of arr(entry.changes).slice(0, 100)) {
      const ch = obj(c);
      const field = str(ch.field) ?? 'unknown';
      const value = obj(ch.value);
      if (object === 'page' && field === 'feed') push(field, ch, feedComment(accountId, value));
      else if (object === 'instagram' && field === 'comments')
        push(field, ch, igComment(accountId, value));
      else if (object === 'page' && field === 'leadgen') push(field, ch, leadgen(accountId, value));
      else push(field, ch, `MARIS chưa dùng sự kiện ${object}/${field}`);
    }
  }
  return out;
}

// ------------------------------------------------------------------------- reading (polling)

/** Messages from GET /{page}/conversations?platform=messenger|instagram. */
export function fromConversations(
  platform: 'messenger' | 'instagram',
  account: Inbound['account'],
  businessIds: string[],
  body: unknown,
): Inbound[] {
  const out: Inbound[] = [];
  for (const c of arr(obj(body).data)) {
    const conv = obj(c);
    const people = arr(obj(conv.participants).data).map(obj);
    const customer = people.find((p) => !businessIds.includes(str(p.id) ?? ''));
    const customerId = str(customer?.id);
    if (!customerId) continue;
    const customerName = str(customer?.name) ?? str(customer?.username);
    for (const m of arr(obj(conv.messages).data)) {
      const msg = obj(m);
      const id = str(msg.id);
      if (!id) continue;
      const fromId = str(obj(msg.from).id);
      const fromBusiness = fromId ? businessIds.includes(fromId) : false;
      out.push({
        channel: platform === 'instagram' ? 'ig_dm' : 'messenger',
        account,
        threadKey: customerId,
        customer: { id: customerId, name: customerName },
        postId: null,
        externalId: id,
        body: clip(str(msg.message) ?? '', 8000),
        attachments: attachmentsOf(msg.attachments),
        at: timeOf(msg.created_time),
        fromBusiness,
        authorName: fromBusiness ? null : customerName,
      });
    }
  }
  return out;
}

/** Comments from GET /{page}/feed?fields=id,comments{...}. */
export function fromPageFeed(pageId: string, body: unknown): Inbound[] {
  const out: Inbound[] = [];
  for (const p of arr(obj(body).data)) {
    const post = obj(p);
    const postId = str(post.id);
    if (!postId) continue;
    for (const c of arr(obj(post.comments).data)) {
      const cm = obj(c);
      const r = feedComment(pageId, {
        item: 'comment',
        verb: 'add',
        comment_id: cm.id,
        post_id: postId,
        parent_id: str(obj(cm.parent).id) ?? postId,
        from: cm.from,
        message: cm.message,
        created_time: cm.created_time,
      });
      if (typeof r !== 'string') out.push(r);
    }
  }
  return out;
}

/** Comments and their replies from GET /{ig}/media?fields=id,comments{...,replies{...}}. */
export function fromIgMedia(igId: string, igUsername: string | null, body: unknown): Inbound[] {
  const out: Inbound[] = [];
  const one = (mediaId: string, raw: Obj, parent: string | null) => {
    const from = obj(raw.from);
    const username = str(from.username) ?? str(raw.username);
    const fromId = str(from.id) ?? (username && username === igUsername ? igId : username);
    const r = igComment(igId, {
      id: raw.id,
      text: raw.text,
      timestamp: raw.timestamp,
      from: { id: fromId, username },
      media: { id: mediaId },
      parent_id: parent,
    });
    if (typeof r !== 'string') out.push(r);
  };
  for (const m of arr(obj(body).data)) {
    const media = obj(m);
    const mediaId = str(media.id);
    if (!mediaId) continue;
    for (const c of arr(obj(media.comments).data)) {
      const cm = obj(c);
      one(mediaId, cm, null);
      const root = str(cm.id);
      for (const r of arr(obj(cm.replies).data)) one(mediaId, obj(r), root);
    }
  }
  return out;
}
