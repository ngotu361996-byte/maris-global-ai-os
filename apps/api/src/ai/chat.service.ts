import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { schema, uuidv7 } from '@maris/db';
import type {
  ChatMessageResponse,
  ChatStreamEvent,
  ConversationDetailResponse,
  ConversationResponse,
  CreateConversation,
  SendMessage,
  UpdateConversation,
} from '@maris/contracts';
import { AuditService } from '../audit/audit.service';
import { DbService, type Tx } from '../db/db.service';
import { OutboxService } from '../outbox/outbox.service';
import { SecretVaultService } from '../secrets/secret-vault.service';
import type { ChatTurn } from './adapters';
import { AiProvidersService } from './ai-providers.service';
import { AiRouterService, type Candidate, type ProviderRow } from './ai-router.service';

const { aiConversations, aiMessages, aiProviderCalls } = schema;
type ConversationRow = typeof aiConversations.$inferSelect;
type MessageRow = typeof aiMessages.$inferSelect;

const DEFAULT_TITLE = 'Cuộc trò chuyện mới';
const HISTORY_MESSAGES = 40;
const HISTORY_CHARS = 120_000;

/** Chat never executes actions: requests to act are answered with a proposal for the user to approve. */
export const SYSTEM_PROMPT = [
  'Bạn là MARIS, AI tổng điều hành của doanh nghiệp trong hệ thống MARIS Global AI Business OS.',
  'Trả lời bằng ngôn ngữ người dùng đang dùng (mặc định tiếng Việt), rõ ràng và đi thẳng vào việc.',
  'Trong khung chat này bạn chưa được cấp quyền thực hiện hành động bên ngoài (đăng bài, gửi tin, chi tiền, sửa dữ liệu).',
  'Khi được yêu cầu làm những việc đó, hãy lập kế hoạch cụ thể gồm mục tiêu, phạm vi, ngân sách và tiêu chí hoàn thành để người dùng phê duyệt.',
  'Không bao giờ yêu cầu người dùng gửi mật khẩu hoặc API key vào khung chat.',
].join(' ');

export interface Ctx {
  tenantId: string;
  userId: string;
  ip: string | null;
}

@Injectable()
export class ChatService {
  constructor(
    private readonly db: DbService,
    private readonly providers: AiProvidersService,
    private readonly router: AiRouterService,
    private readonly vault: SecretVaultService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  list(ctx: Ctx): Promise<ConversationResponse[]> {
    return this.db.withContext(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(aiConversations)
        .where(and(eq(aiConversations.tenantId, ctx.tenantId), eq(aiConversations.userId, ctx.userId), isNull(aiConversations.deletedAt)))
        .orderBy(desc(aiConversations.updatedAt))
        .limit(200);
      return rows.map(conversationResponse);
    });
  }

  create(ctx: Ctx, body: CreateConversation): Promise<ConversationResponse> {
    return this.db.withContext(ctx, async (tx) => {
      if (body.providerId) await this.usableProvider(tx, ctx.tenantId, body.providerId);
      const [row] = await tx
        .insert(aiConversations)
        .values({
          id: uuidv7(),
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          title: body.title ?? DEFAULT_TITLE,
          providerId: body.providerId ?? null,
          model: body.model ?? null,
        })
        .returning();
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ai.conversation.created',
        targetType: 'ai_conversation',
        targetId: row!.id,
        ip: ctx.ip,
      });
      return conversationResponse(row!);
    });
  }

  get(ctx: Ctx, id: string): Promise<ConversationDetailResponse> {
    return this.db.withContext(ctx, async (tx) => {
      const conv = await this.conversation(tx, ctx, id);
      const messages = await tx.select().from(aiMessages).where(eq(aiMessages.conversationId, id)).orderBy(asc(aiMessages.createdAt));
      return { ...conversationResponse(conv), messages: messages.map(messageResponse) };
    });
  }

  update(ctx: Ctx, id: string, body: UpdateConversation): Promise<ConversationResponse> {
    return this.db.withContext(ctx, async (tx) => {
      await this.conversation(tx, ctx, id);
      if (body.providerId) await this.usableProvider(tx, ctx.tenantId, body.providerId);
      const [row] = await tx
        .update(aiConversations)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(aiConversations.id, id))
        .returning();
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ai.conversation.updated',
        targetType: 'ai_conversation',
        targetId: id,
        metadata: { fields: Object.keys(body) },
        ip: ctx.ip,
      });
      return conversationResponse(row!);
    });
  }

  remove(ctx: Ctx, id: string): Promise<void> {
    return this.db.withContext(ctx, async (tx) => {
      await this.conversation(tx, ctx, id);
      await tx.update(aiConversations).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(aiConversations.id, id));
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ai.conversation.deleted',
        targetType: 'ai_conversation',
        targetId: id,
        ip: ctx.ip,
      });
    });
  }

  /**
   * Stores the user's message and an empty assistant reply, then streams the reply through
   * the router. No transaction is held while the provider streams; the result is saved after.
   * Errors before streaming starts throw (normal HTTP error); later ones become stream events.
   */
  async prepare(ctx: Ctx, conversationId: string, body: SendMessage) {
    return this.db.withContext(ctx, async (tx) => {
      const conv = await this.conversation(tx, ctx, conversationId);
      let providerId = conv.providerId;
      let model = conv.model;
      if (body.providerId !== undefined) {
        providerId = body.providerId;
        model = body.model ?? null;
      } else if (body.model !== undefined) {
        model = body.model;
      }
      if (providerId) await this.usableProvider(tx, ctx.tenantId, providerId);

      const history = await tx
        .select({ role: aiMessages.role, content: aiMessages.content, status: aiMessages.status })
        .from(aiMessages)
        .where(eq(aiMessages.conversationId, conversationId))
        .orderBy(desc(aiMessages.createdAt))
        .limit(HISTORY_MESSAGES);

      const now = Date.now();
      const userMessage: MessageRow = {
        id: uuidv7(),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        conversationId,
        role: 'user',
        content: body.content,
        status: 'complete',
        providerId: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        latencyMs: null,
        errorCode: null,
        createdAt: new Date(now),
      };
      const assistantId = uuidv7();
      await tx.insert(aiMessages).values(userMessage);
      // created_at one millisecond later keeps the pair in order.
      await tx.insert(aiMessages).values({
        id: assistantId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        conversationId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: new Date(now + 1),
      });
      const title = conv.title === DEFAULT_TITLE ? titleFrom(body.content) : conv.title;
      await tx
        .update(aiConversations)
        .set({ providerId, model, title, updatedAt: new Date() })
        .where(eq(aiConversations.id, conversationId));
      await this.audit.append(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        action: 'ai.message.sent',
        targetType: 'ai_conversation',
        targetId: conversationId,
        // Message text stays out of the audit log.
        metadata: { messageId: userMessage.id, chars: body.content.length },
        ip: ctx.ip,
      });

      const rows = (await this.providers.rows(tx, ctx.tenantId)).filter((p) => p.enabled);
      const candidates = orderCandidates(rows, providerId, model);
      const messages = buildTurns(history.reverse(), body.content);
      return { userMessageId: userMessage.id, assistantId, candidates, messages };
    });
  }

  async stream(
    ctx: Ctx,
    prepared: Awaited<ReturnType<ChatService['prepare']>>,
    emit: (e: ChatStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<ChatMessageResponse> {
    emit({ type: 'start', userMessageId: prepared.userMessageId, assistantMessageId: prepared.assistantId });
    const result = await this.router.route({
      candidates: prepared.candidates,
      messages: prepared.messages,
      signal,
      emit,
      resolveKey: (p: ProviderRow) =>
        p.secretRef ? this.db.withContext(ctx, (tx) => this.vault.resolve(tx, ctx.tenantId, p.secretRef!)) : Promise.resolve(null),
    });

    return this.db.withContext(ctx, async (tx) => {
      const [saved] = await tx
        .update(aiMessages)
        .set({
          content: result.content,
          status: result.status,
          providerId: result.provider?.id ?? null,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.costUsd == null ? null : String(result.costUsd),
          latencyMs: result.latencyMs,
          errorCode: result.errorCode,
        })
        .where(eq(aiMessages.id, prepared.assistantId))
        .returning();
      if (result.calls.length) {
        await tx.insert(aiProviderCalls).values(
          result.calls.map((c) => ({
            id: uuidv7(),
            tenantId: ctx.tenantId,
            messageId: prepared.assistantId,
            providerId: c.providerId,
            model: c.model,
            outcome: c.outcome,
            errorCode: c.errorCode,
            inputTokens: c.inputTokens,
            outputTokens: c.outputTokens,
            costUsd: c.costUsd == null ? null : String(c.costUsd),
            latencyMs: c.latencyMs,
          })),
        );
      }
      await tx.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, saved!.conversationId));
      await this.outbox.enqueue(tx, {
        tenantId: ctx.tenantId,
        type: 'ai.message.completed',
        payload: {
          conversationId: saved!.conversationId,
          messageId: saved!.id,
          status: result.status,
          providerId: result.provider?.id ?? null,
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.costUsd,
          attempts: result.calls.length,
        },
      });
      const message = messageResponse(saved!);
      if (result.status === 'complete') emit({ type: 'done', message });
      else emit({ type: 'error', code: result.errorCode ?? 'ERROR', message: result.errorMessage ?? 'Lỗi' });
      return message;
    });
  }

  private async conversation(tx: Tx, ctx: Ctx, id: string): Promise<ConversationRow> {
    const [row] = await tx
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, id), eq(aiConversations.userId, ctx.userId), isNull(aiConversations.deletedAt)));
    if (!row) throw new NotFoundException({ code: 'CONVERSATION_NOT_FOUND', message: 'Không tìm thấy cuộc trò chuyện' });
    return row;
  }

  private async usableProvider(tx: Tx, tenantId: string, id: string): Promise<void> {
    const p = await this.providers.get(tx, tenantId, id);
    if (!p.enabled) throw new BadRequestException({ code: 'AI_PROVIDER_DISABLED', message: `${p.name} đang tắt` });
  }
}

/** Chosen provider first (with the chosen model), then the rest of the failover order with their default models. */
export function orderCandidates(enabled: ProviderRow[], providerId: string | null, model: string | null): Candidate[] {
  const chosen = providerId ? enabled.find((p) => p.id === providerId) : undefined;
  const rest = enabled.filter((p) => p !== chosen);
  return [
    ...(chosen ? [{ provider: chosen, model: model ?? chosen.defaultModel }] : []),
    ...rest.map((p) => ({ provider: p, model: p.defaultModel })),
  ];
}

export function buildTurns(history: { role: 'user' | 'assistant'; content: string; status: string }[], content: string): ChatTurn[] {
  const kept = history.filter((m) => m.status === 'complete' || (m.role === 'assistant' && m.status === 'cancelled' && m.content));
  const turns: ChatTurn[] = [];
  let chars = content.length;
  for (let i = kept.length - 1; i >= 0; i--) {
    const m = kept[i]!;
    if (!m.content) continue;
    chars += m.content.length;
    if (chars > HISTORY_CHARS) break;
    turns.unshift({ role: m.role, content: m.content });
  }
  return [{ role: 'system', content: SYSTEM_PROMPT }, ...turns, { role: 'user', content }];
}

function titleFrom(content: string): string {
  const one = content.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

function conversationResponse(r: ConversationRow): ConversationResponse {
  return {
    id: r.id,
    title: r.title,
    providerId: r.providerId,
    model: r.model,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function messageResponse(r: MessageRow): ChatMessageResponse {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    status: r.status,
    providerId: r.providerId,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd == null ? null : Number(r.costUsd),
    latencyMs: r.latencyMs,
    errorCode: r.errorCode,
    createdAt: r.createdAt.toISOString(),
  };
}

