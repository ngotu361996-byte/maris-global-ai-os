import {
  Body,
  Controller,
  Get,
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
  decideAdChangeSchema,
  listAdsSchema,
  setAdAccountSchema,
  setAdBudgetSchema,
  setAdStatusSchema,
  type AdAccountResponse,
  type AdChangeResponse,
  type AdObjectResponse,
  type AdsSummaryResponse,
  type AdSyncResponse,
  type CampaignDetail,
  type DecideAdChange,
  type ListAds,
  type SetAdAccount,
  type SetAdBudget,
  type SetAdStatus,
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
import { MetaAdsService } from './meta-ads.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/**
 * Ads Command Center (spec Part 19, M23). Reading needs ads.read; reading Meta now, pausing,
 * turning on and budgets within the approved limit need ads.manage; the limit itself and changes
 * above it need ads.approve.
 */
@Controller('ads')
@UseGuards(AuthGuard, TenantGuard)
export class MetaAdsController {
  constructor(private readonly ads: MetaAdsService) {}

  @Get('summary')
  @RequirePermission('ads.read')
  summary(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listAdsSchema)) query: ListAds,
  ): Promise<AdsSummaryResponse> {
    return this.ads.summary(
      ctxOf(user, tenant, req),
      query,
      tenant.permissions.has('ads.manage'),
      tenant.permissions.has('ads.approve'),
    );
  }

  @Get('campaigns')
  @RequirePermission('ads.read')
  campaigns(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listAdsSchema)) query: ListAds,
  ): Promise<AdObjectResponse[]> {
    return this.ads.campaigns(ctxOf(user, tenant, req), query);
  }

  @Get('campaigns/:id')
  @RequirePermission('ads.read')
  campaign(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(listAdsSchema)) query: ListAds,
  ): Promise<CampaignDetail> {
    return this.ads.campaign(ctxOf(user, tenant, req), id, query.days);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('ads.manage')
  @RateLimit({ name: 'ads-sync', limit: 6, windowSec: 600, by: 'ip' })
  sync(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<AdSyncResponse> {
    return this.ads.syncTenant({ tenantId: tenant.id, userId: user.id }, true);
  }

  @Post('objects/:id/status')
  @HttpCode(200)
  @RequirePermission('ads.manage')
  setStatus(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setAdStatusSchema)) body: SetAdStatus,
  ): Promise<AdChangeResponse> {
    return this.ads.setStatus(ctxOf(user, tenant, req), id, body);
  }

  @Post('objects/:id/budget')
  @HttpCode(200)
  @RequirePermission('ads.manage')
  setBudget(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setAdBudgetSchema)) body: SetAdBudget,
  ): Promise<AdChangeResponse> {
    return this.ads.setBudget(ctxOf(user, tenant, req), id, body);
  }

  @Get('changes')
  @RequirePermission('ads.read')
  changes(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<AdChangeResponse[]> {
    return this.ads.changes(ctxOf(user, tenant, req));
  }

  @Post('changes/:id/approve')
  @HttpCode(200)
  @RequirePermission('ads.approve')
  approve(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decideAdChangeSchema)) body: DecideAdChange,
  ): Promise<AdChangeResponse> {
    return this.ads.approve(ctxOf(user, tenant, req), id, body);
  }

  /** Refuses a change (ads.approve), or withdraws one's own request. */
  @Post('changes/:id/reject')
  @HttpCode(200)
  @RequirePermission('ads.manage')
  reject(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(decideAdChangeSchema)) body: DecideAdChange,
  ): Promise<AdChangeResponse> {
    return this.ads.reject(
      ctxOf(user, tenant, req),
      id,
      body,
      tenant.permissions.has('ads.approve'),
    );
  }

  @Patch('accounts/:id')
  @RequirePermission('ads.approve')
  setAccount(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setAdAccountSchema)) body: SetAdAccount,
  ): Promise<AdAccountResponse> {
    return this.ads.setAccount(ctxOf(user, tenant, req), id, body);
  }
}
