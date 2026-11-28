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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  metaCallbackSchema,
  setMetaAppSchema,
  updateMetaAssetSchema,
  type ApiCallResponse,
  type MetaAssetResponse,
  type MetaCallback,
  type MetaOauthStartResponse,
  type MetaStatusResponse,
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
import { MetaService } from './meta.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/**
 * Meta Control Center (spec Part 14). Reading needs meta.read; the Meta App, signing in and out
 * and turning assets on or off need meta.manage.
 */
@Controller('meta')
@UseGuards(AuthGuard, TenantGuard)
export class MetaController {
  constructor(private readonly meta: MetaService) {}

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
}
