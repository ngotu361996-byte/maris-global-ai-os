import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  createConversationSchema,
  sendMessageSchema,
  updateConversationSchema,
  type ChatStreamEvent,
  type ConversationDetailResponse,
  type ConversationResponse,
  type CreateConversation,
  type SendMessage,
  type UpdateConversation,
} from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { ChatService, type Ctx } from './chat.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({ tenantId: tenant.id, userId: user.id, ip: clientIp(req) });

@Controller('ai/conversations')
@UseGuards(AuthGuard, TenantGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  @RequirePermission('ai.chat')
  list(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Req() req: Request): Promise<ConversationResponse[]> {
    return this.chat.list(ctxOf(user, tenant, req));
  }

  @Post()
  @RequirePermission('ai.chat')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createConversationSchema)) body: CreateConversation,
    @Req() req: Request,
  ): Promise<ConversationResponse> {
    return this.chat.create(ctxOf(user, tenant, req), body);
  }

  @Get(':id')
  @RequirePermission('ai.chat')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ConversationDetailResponse> {
    return this.chat.get(ctxOf(user, tenant, req), id);
  }

  @Patch(':id')
  @RequirePermission('ai.chat')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateConversationSchema)) body: UpdateConversation,
    @Req() req: Request,
  ): Promise<ConversationResponse> {
    return this.chat.update(ctxOf(user, tenant, req), id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('ai.chat')
  remove(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.chat.remove(ctxOf(user, tenant, req), id);
  }

  /**
   * Sends a message and streams the reply as server-sent events (one JSON ChatStreamEvent per
   * `data:` line). Closing the connection cancels the reply; what arrived so far is kept.
   */
  @Post(':id/messages')
  @RequirePermission('ai.chat')
  async send(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(sendMessageSchema)) body: SendMessage,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ctx = ctxOf(user, tenant, req);
    // Validation and storage errors surface as normal JSON errors (thrown before headers are sent).
    const prepared = await this.chat.prepare(ctx, id, body);

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const emit = (event: ChatStreamEvent) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const keepAlive = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000);
    try {
      await this.chat.stream(ctx, prepared, emit, abort.signal);
    } catch {
      emit({ type: 'error', code: 'INTERNAL', message: 'Lỗi hệ thống khi lưu câu trả lời' });
    } finally {
      clearInterval(keepAlive);
      if (!res.writableEnded) res.end();
    }
  }
}
