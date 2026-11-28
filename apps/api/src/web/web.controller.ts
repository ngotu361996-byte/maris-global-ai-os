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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createSiteSchema,
  updateSiteSchema,
  webGooglePropertiesSchema,
  webReportSchema,
  type CreateSite,
  type Ga4PropertyResponse,
  type GscSiteResponse,
  type UpdateSite,
  type WebCheckDetailResponse,
  type WebCheckResponse,
  type WebReportResponse,
  type WebSiteResponse,
  type WebStatusResponse,
  type WebSyncResponse,
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
import { WebService } from './web.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/**
 * Website and SEO Center (spec Parts 16 and 18, M21). Reading needs web.read; adding, linking and
 * removing sites, listing Google properties, reading now and running a website check need
 * web.manage.
 */
@Controller('web')
@UseGuards(AuthGuard, TenantGuard)
export class WebController {
  constructor(private readonly web: WebService) {}

  @Get()
  @RequirePermission('web.read')
  status(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<WebStatusResponse> {
    return this.web.status(ctxOf(user, tenant, req));
  }

  @Post('sites')
  @RequirePermission('web.manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(createSiteSchema)) body: CreateSite,
  ): Promise<WebSiteResponse> {
    return this.web.create(ctxOf(user, tenant, req), body);
  }

  @Patch('sites/:id')
  @RequirePermission('web.manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateSiteSchema)) body: UpdateSite,
  ): Promise<WebSiteResponse> {
    return this.web.update(ctxOf(user, tenant, req), id, body);
  }

  @Delete('sites/:id')
  @HttpCode(204)
  @RequirePermission('web.manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.web.remove(ctxOf(user, tenant, req), id);
  }

  @Get('google/ga4')
  @RequirePermission('web.manage')
  ga4(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(webGooglePropertiesSchema)) q: z.infer<typeof webGooglePropertiesSchema>,
  ): Promise<Ga4PropertyResponse[]> {
    return this.web.ga4Properties(ctxOf(user, tenant, req), q.connectionId);
  }

  @Get('google/gsc')
  @RequirePermission('web.manage')
  gsc(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(webGooglePropertiesSchema)) q: z.infer<typeof webGooglePropertiesSchema>,
  ): Promise<GscSiteResponse[]> {
    return this.web.gscSites(ctxOf(user, tenant, req), q.connectionId);
  }

  @Post('sites/:id/sync')
  @HttpCode(200)
  @RequirePermission('web.manage')
  syncSite(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WebSyncResponse> {
    return this.web.sync(ctxOf(user, tenant, req), id);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('web.manage')
  syncAll(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<WebSyncResponse> {
    return this.web.sync(ctxOf(user, tenant, req));
  }

  @Get('report')
  @RequirePermission('web.read')
  report(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(webReportSchema)) q: z.infer<typeof webReportSchema>,
  ): Promise<WebReportResponse> {
    return this.web.report(ctxOf(user, tenant, req), q.siteId, q.days);
  }

  @Post('sites/:id/checks')
  @RequirePermission('web.manage')
  startCheck(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WebCheckResponse> {
    return this.web.startCheck(ctxOf(user, tenant, req), id);
  }

  @Get('sites/:id/checks')
  @RequirePermission('web.read')
  checks(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WebCheckResponse[]> {
    return this.web.checks(ctxOf(user, tenant, req), id);
  }

  @Get('checks/:id')
  @RequirePermission('web.read')
  check(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WebCheckDetailResponse> {
    return this.web.check(ctxOf(user, tenant, req), id);
  }
}
