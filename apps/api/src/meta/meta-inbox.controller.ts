import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  listInboxSchema,
  replyInboxSchema,
  updateThreadSchema,
  type InboxSummaryResponse,
  type InboxThreadDetail,
  type InboxThreadResponse,
  type ListInbox,
  type ReplyInbox,
  type UpdateThread,
} from '@maris/contracts';
import type { Ctx } from '../ai/chat.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  clientIp,
  CurrentTenant,
  CurrentUser,
  type AuthUser,
  type TenantContext,
} from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { RateLimit } from '../ratelimit/rate-limit.guard';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { MetaInboxService } from './meta-inbox.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/**
 * Inbox for Facebook and Instagram (spec Part 20). Reading needs inbox.read; replying, AI
 * suggestions, assigning and closing need inbox.reply; reading Meta now and turning on the
 * webhook for the Pages need meta.manage.
 */
@Controller('meta/inbox')
@UseGuards(AuthGuard, TenantGuard)
export class MetaInboxController {
  constructor(private readonly inbox: MetaInboxService) {}

  @Get('summary')
  @RequirePermission('inbox.read')
  summary(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<InboxSummaryResponse> {
    return this.inbox.summary(ctxOf(user, tenant, req));
  }

  @Get('threads')
  @RequirePermission('inbox.read')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listInboxSchema)) query: ListInbox,
  ): Promise<InboxThreadResponse[]> {
    return this.inbox.list(ctxOf(user, tenant, req), query);
  }

  @Get('threads/:id')
  @RequirePermission('inbox.read')
  detail(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InboxThreadDetail> {
    return this.inbox.detail(ctxOf(user, tenant, req), id);
  }

  @Patch('threads/:id')
  @RequirePermission('inbox.reply')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateThreadSchema)) body: UpdateThread,
  ): Promise<InboxThreadDetail> {
    return this.inbox.update(ctxOf(user, tenant, req), id, body);
  }

  @Post('threads/:id/reply')
  @HttpCode(200)
  @RequirePermission('inbox.reply')
  reply(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(replyInboxSchema)) body: ReplyInbox,
  ): Promise<InboxThreadDetail> {
    return this.inbox.reply(ctxOf(user, tenant, req), id, body);
  }

  @Post('threads/:id/suggest')
  @HttpCode(200)
  @RequirePermission('inbox.reply')
  @RateLimit({ name: 'inbox-suggest', limit: 30, windowSec: 60, by: 'ip' })
  suggest(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InboxThreadDetail> {
    return this.inbox.suggest(ctxOf(user, tenant, req), id);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('meta.manage')
  @RateLimit({ name: 'inbox-sync', limit: 6, windowSec: 600, by: 'ip' })
  sync(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<InboxSummaryResponse> {
    return this.inbox.syncNow(ctxOf(user, tenant, req));
  }

  @Post('webhook/subscribe')
  @HttpCode(200)
  @RequirePermission('meta.manage')
  subscribe(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<InboxSummaryResponse> {
    return this.inbox.subscribe(ctxOf(user, tenant, req));
  }
}

/**
 * Public endpoint for Meta's webhook. No session: Meta proves itself with the verify token when
 * the callback is set up, and with an X-Hub-Signature-256 made with the App Secret on each delivery.
 */
@Controller('meta/webhook')
export class MetaWebhookController {
  constructor(private readonly inbox: MetaInboxService) {}

  @Get(':tenantId')
  @RateLimit({ name: 'meta-webhook-verify', limit: 30, windowSec: 60, by: 'ip' })
  verify(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): Promise<string> {
    return this.inbox.verify(tenantId, mode, token, challenge);
  }

  @Post(':tenantId')
  @HttpCode(200)
  @RateLimit({ name: 'meta-webhook', limit: 600, windowSec: 60, by: 'ip' })
  receive(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: unknown,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<{ received: number; stored: number }> {
    return this.inbox.receive(tenantId, req.rawBody, signature, body);
  }
}
