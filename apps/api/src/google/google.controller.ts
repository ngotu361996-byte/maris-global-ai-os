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
  googleCallbackSchema,
  googleOauthStartSchema,
  listYoutubeUploadsSchema,
  scheduleYoutubeSchema,
  setGoogleAppSchema,
  updateYoutubeChannelSchema,
  type ApiCallResponse,
  type GoogleCallback,
  type GoogleOauthStart,
  type GoogleOauthStartResponse,
  type GoogleStatusResponse,
  type ListYoutubeUploads,
  type ScheduleYoutube,
  type SetGoogleApp,
  type UpdateYoutubeChannel,
  type YoutubeChannelResponse,
  type YoutubeUploadResponse,
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
import { GoogleService } from './google.service';
import { YoutubePublishService } from './youtube-publish.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/**
 * Google Center and YouTube Center (spec Parts 16 and 17). Reading needs google.read; the OAuth
 * client, signing accounts in and out and turning channels on or off need google.manage.
 * Uploading, cancelling and retrying videos need google.publish.
 */
@Controller('google')
@UseGuards(AuthGuard, TenantGuard)
export class GoogleController {
  constructor(
    private readonly google: GoogleService,
    private readonly youtube: YoutubePublishService,
  ) {}

  @Get()
  @RequirePermission('google.read')
  status(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<GoogleStatusResponse> {
    return this.google.status(ctxOf(user, tenant, req));
  }

  @Put('app')
  @RequirePermission('google.manage')
  setApp(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(setGoogleAppSchema)) body: SetGoogleApp,
  ): Promise<GoogleStatusResponse> {
    return this.google.setApp(ctxOf(user, tenant, req), body);
  }

  @Post('oauth/start')
  @HttpCode(200)
  @RequirePermission('google.manage')
  oauthStart(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(googleOauthStartSchema)) body: GoogleOauthStart,
  ): Promise<GoogleOauthStartResponse> {
    return this.google.oauthStart(ctxOf(user, tenant, req), body);
  }

  @Post('oauth/callback')
  @HttpCode(200)
  @RequirePermission('google.manage')
  oauthCallback(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(googleCallbackSchema)) body: GoogleCallback,
  ): Promise<GoogleStatusResponse> {
    return this.google.oauthCallback(ctxOf(user, tenant, req), body);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('google.manage')
  sync(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<GoogleStatusResponse> {
    return this.google.sync(ctxOf(user, tenant, req));
  }

  @Patch('channels/:id')
  @RequirePermission('google.manage')
  setChannel(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateYoutubeChannelSchema)) body: UpdateYoutubeChannel,
  ): Promise<YoutubeChannelResponse> {
    return this.google.setChannel(ctxOf(user, tenant, req), id, body);
  }

  @Delete('connections/:id')
  @RequirePermission('google.manage')
  disconnect(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<GoogleStatusResponse> {
    return this.google.disconnect(ctxOf(user, tenant, req), id);
  }

  @Get('calls')
  @RequirePermission('google.read')
  calls(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<ApiCallResponse[]> {
    return this.google.calls(ctxOf(user, tenant, req));
  }

  @Post('youtube/uploads')
  @RequirePermission('google.publish')
  schedule(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(scheduleYoutubeSchema)) body: ScheduleYoutube,
  ): Promise<YoutubeUploadResponse[]> {
    return this.youtube.schedule(ctxOf(user, tenant, req), body);
  }

  @Get('youtube/uploads')
  @RequirePermission('google.read')
  uploads(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listYoutubeUploadsSchema)) query: ListYoutubeUploads,
  ): Promise<YoutubeUploadResponse[]> {
    return this.youtube.list(ctxOf(user, tenant, req), query);
  }

  @Post('youtube/uploads/:id/cancel')
  @HttpCode(200)
  @RequirePermission('google.publish')
  cancel(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<YoutubeUploadResponse> {
    return this.youtube.cancel(ctxOf(user, tenant, req), id);
  }

  @Post('youtube/uploads/:id/retry')
  @HttpCode(200)
  @RequirePermission('google.publish')
  retry(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<YoutubeUploadResponse> {
    return this.youtube.retry(ctxOf(user, tenant, req), id);
  }
}
