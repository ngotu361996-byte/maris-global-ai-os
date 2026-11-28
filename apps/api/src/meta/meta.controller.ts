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
import {
  listMetaPostsSchema,
  metaCallbackSchema,
  scheduleMetaPostSchema,
  setMetaAppSchema,
  updateMetaAssetSchema,
  type ApiCallResponse,
  type ListMetaPosts,
  type MetaAssetResponse,
  type MetaCallback,
  type MetaOauthStartResponse,
  type MetaPostResponse,
  type MetaStatusResponse,
  type ScheduleMetaPost,
  type SetMetaApp,
  type UpdateMetaAsset,
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
import { MetaPublishService } from './meta-publish.service';
import { MetaService } from './meta.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/**
 * Meta Control Center (spec Part 14). Reading needs meta.read; the Meta App, signing in and out
 * and turning assets on or off need meta.manage. Scheduling, cancelling and retrying posts need
 * meta.publish.
 */
@Controller('meta')
@UseGuards(AuthGuard, TenantGuard)
export class MetaController {
  constructor(
    private readonly meta: MetaService,
    private readonly publisher: MetaPublishService,
  ) {}

  @Get()
  @RequirePermission('meta.read')
  status(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<MetaStatusResponse> {
    return this.meta.status(ctxOf(user, tenant, req));
  }

  @Put('app')
  @RequirePermission('meta.manage')
  setApp(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(setMetaAppSchema)) body: SetMetaApp,
  ): Promise<MetaStatusResponse> {
    return this.meta.setApp(ctxOf(user, tenant, req), body);
  }

  @Post('oauth/start')
  @HttpCode(200)
  @RequirePermission('meta.manage')
  oauthStart(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<MetaOauthStartResponse> {
    return this.meta.oauthStart(ctxOf(user, tenant, req));
  }

  @Post('oauth/callback')
  @HttpCode(200)
  @RequirePermission('meta.manage')
  oauthCallback(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(metaCallbackSchema)) body: MetaCallback,
  ): Promise<MetaStatusResponse> {
    return this.meta.oauthCallback(ctxOf(user, tenant, req), body);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('meta.manage')
  sync(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<MetaStatusResponse> {
    return this.meta.sync(ctxOf(user, tenant, req));
  }

  @Post('check')
  @HttpCode(200)
  @RequirePermission('meta.read')
  check(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<MetaStatusResponse> {
    return this.meta.check(ctxOf(user, tenant, req));
  }

  @Patch('assets/:id')
  @RequirePermission('meta.manage')
  setAsset(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateMetaAssetSchema)) body: UpdateMetaAsset,
  ): Promise<MetaAssetResponse> {
    return this.meta.setAsset(ctxOf(user, tenant, req), id, body);
  }

  @Delete('connection')
  @RequirePermission('meta.manage')
  disconnect(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<MetaStatusResponse> {
    return this.meta.disconnect(ctxOf(user, tenant, req));
  }

  @Get('calls')
  @RequirePermission('meta.read')
  calls(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<ApiCallResponse[]> {
    return this.meta.calls(ctxOf(user, tenant, req));
  }

  @Post('posts')
  @RequirePermission('meta.publish')
  schedulePosts(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(scheduleMetaPostSchema)) body: ScheduleMetaPost,
  ): Promise<MetaPostResponse[]> {
    return this.publisher.schedule(ctxOf(user, tenant, req), body);
  }

  @Get('posts')
  @RequirePermission('meta.read')
  posts(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listMetaPostsSchema)) query: ListMetaPosts,
  ): Promise<MetaPostResponse[]> {
    return this.publisher.list(ctxOf(user, tenant, req), query);
  }

  @Post('posts/:id/cancel')
  @HttpCode(200)
  @RequirePermission('meta.publish')
  cancelPost(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MetaPostResponse> {
    return this.publisher.cancel(ctxOf(user, tenant, req), id);
  }

  @Post('posts/:id/retry')
  @HttpCode(200)
  @RequirePermission('meta.publish')
  retryPost(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MetaPostResponse> {
    return this.publisher.retry(ctxOf(user, tenant, req), id);
  }
}
