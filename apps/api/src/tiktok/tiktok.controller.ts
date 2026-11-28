import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  listTiktokPostsSchema,
  scheduleTiktokSchema,
  setTiktokAppSchema,
  tiktokCallbackSchema,
  tiktokOauthStartSchema,
  updateTiktokAccountSchema,
  type ApiCallResponse,
  type ListTiktokPosts,
  type ScheduleTiktok,
  type SetTiktokApp,
  type TiktokAccountResponse,
  type TiktokCallback,
  type TiktokCreatorResponse,
  type TiktokOauthStart,
  type TiktokOauthStartResponse,
  type TiktokPostResponse,
  type TiktokReportResponse,
  type TiktokStatusResponse,
  type TiktokVideoResponse,
  type UpdateTiktokAccount,
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
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { TiktokPublishService } from './tiktok-publish.service';
import { TiktokService } from './tiktok.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

const videosQuery = z.object({ accountId: z.uuid().optional() });
const reportQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/**
 * TikTok Center (spec Part 17, M19). Reading needs tiktok.read; the app, signing accounts in and
 * out and turning them on or off need tiktok.manage. Posting, cancelling, retrying and asking
 * TikTok what a creator may post need tiktok.publish.
 */
@Controller('tiktok')
@UseGuards(AuthGuard, TenantGuard)
export class TiktokController {
  constructor(
    private readonly tiktok: TiktokService,
    private readonly posts: TiktokPublishService,
  ) {}

  @Get()
  @RequirePermission('tiktok.read')
  status(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<TiktokStatusResponse> {
    return this.tiktok.status(ctxOf(user, tenant, req));
  }

  @Put('app')
  @RequirePermission('tiktok.manage')
  setApp(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(setTiktokAppSchema)) body: SetTiktokApp,
  ): Promise<TiktokStatusResponse> {
    return this.tiktok.setApp(ctxOf(user, tenant, req), body);
  }

  @Post('oauth/start')
  @HttpCode(200)
  @RequirePermission('tiktok.manage')
  oauthStart(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(tiktokOauthStartSchema)) body: TiktokOauthStart,
  ): Promise<TiktokOauthStartResponse> {
    return this.tiktok.oauthStart(ctxOf(user, tenant, req), body);
  }

  @Post('oauth/callback')
  @HttpCode(200)
  @RequirePermission('tiktok.manage')
  oauthCallback(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(tiktokCallbackSchema)) body: TiktokCallback,
  ): Promise<TiktokStatusResponse> {
    return this.tiktok.oauthCallback(ctxOf(user, tenant, req), body);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('tiktok.manage')
  sync(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<TiktokStatusResponse> {
    return this.tiktok.sync(ctxOf(user, tenant, req));
  }

  @Patch('accounts/:id')
  @RequirePermission('tiktok.manage')
  setAccount(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateTiktokAccountSchema)) body: UpdateTiktokAccount,
  ): Promise<TiktokAccountResponse> {
    return this.tiktok.setAccount(ctxOf(user, tenant, req), id, body);
  }

  @Delete('accounts/:id')
  @RequirePermission('tiktok.manage')
  disconnect(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TiktokStatusResponse> {
    return this.tiktok.disconnect(ctxOf(user, tenant, req), id);
  }

  /** Asks TikTok what this creator may post now, for the post form (TikTok's guidelines). */
  @Post('accounts/:id/creator')
  @HttpCode(200)
  @RequirePermission('tiktok.publish')
  creator(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TiktokCreatorResponse> {
    return this.tiktok.creatorFor(ctxOf(user, tenant, req), id);
  }

  @Get('calls')
  @RequirePermission('tiktok.read')
  calls(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<ApiCallResponse[]> {
    return this.tiktok.calls(ctxOf(user, tenant, req));
  }

  @Get('videos')
  @RequirePermission('tiktok.read')
  videos(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(videosQuery)) query: z.infer<typeof videosQuery>,
  ): Promise<TiktokVideoResponse[]> {
    return this.tiktok.videos(ctxOf(user, tenant, req), query.accountId);
  }

  @Get('report')
  @RequirePermission('tiktok.read')
  report(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(reportQuery)) query: z.infer<typeof reportQuery>,
  ): Promise<TiktokReportResponse> {
    return this.tiktok.report(ctxOf(user, tenant, req), query.days);
  }

  @Post('posts')
  @RequirePermission('tiktok.publish')
  schedule(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(scheduleTiktokSchema)) body: ScheduleTiktok,
  ): Promise<TiktokPostResponse[]> {
    return this.posts.schedule(ctxOf(user, tenant, req), body);
  }

  @Get('posts')
  @RequirePermission('tiktok.read')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listTiktokPostsSchema)) query: ListTiktokPosts,
  ): Promise<TiktokPostResponse[]> {
    return this.posts.list(ctxOf(user, tenant, req), query);
  }

  @Post('posts/:id/cancel')
  @HttpCode(200)
  @RequirePermission('tiktok.publish')
  cancel(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TiktokPostResponse> {
    return this.posts.cancel(ctxOf(user, tenant, req), id);
  }

  @Post('posts/:id/retry')
  @HttpCode(200)
  @RequirePermission('tiktok.publish')
  retry(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<TiktokPostResponse> {
    return this.posts.retry(ctxOf(user, tenant, req), id);
  }
}
