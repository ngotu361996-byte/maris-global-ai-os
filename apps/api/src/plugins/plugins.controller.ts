import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  activatePluginSchema,
  addPublisherSchema,
  installPluginSchema,
  revokePluginSchema,
  type ActivatePlugin,
  type AddPublisher,
  type InstallPlugin,
  type PluginManifest,
  type PluginResponse,
  type PluginSample,
  type PluginVersionResponse,
  type PublisherResponse,
  type RevokePlugin,
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
import { PluginsService } from './plugins.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/**
 * Extension API for plugins. Managers install, update, pause, revoke and remove plugins; turning a
 * plugin on and choosing which publisher keys to trust need ai.approve.
 */
@Controller('plugins')
@UseGuards(AuthGuard, TenantGuard)
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  @RequirePermission('ai.manage')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<PluginResponse[]> {
    return this.plugins.list(ctxOf(user, tenant, req));
  }

  @Get('samples')
  @RequirePermission('ai.manage')
  samples(): readonly PluginSample[] {
    return this.plugins.samples();
  }

  @Get('publishers')
  @RequirePermission('ai.manage')
  publishers(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<PublisherResponse[]> {
    return this.plugins.publishers(ctxOf(user, tenant, req));
  }

  @Post('publishers')
  @RequirePermission('ai.approve')
  addPublisher(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(addPublisherSchema)) body: AddPublisher,
    @Req() req: Request,
  ): Promise<PublisherResponse> {
    return this.plugins.addPublisher(ctxOf(user, tenant, req), body);
  }

  @Delete('publishers/:id')
  @HttpCode(204)
  @RequirePermission('ai.approve')
  async revokePublisher(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.plugins.revokePublisher(ctxOf(user, tenant, req), id);
  }

  @Post()
  @RequirePermission('ai.manage')
  install(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(installPluginSchema)) body: InstallPlugin,
    @Req() req: Request,
  ): Promise<PluginResponse> {
    return this.plugins.install(ctxOf(user, tenant, req), body);
  }

  @Get(':id')
  @RequirePermission('ai.manage')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<PluginResponse> {
    return this.plugins.get(ctxOf(user, tenant, req), id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('ai.manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.plugins.remove(ctxOf(user, tenant, req), id);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('ai.approve')
  activate(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(activatePluginSchema)) body: ActivatePlugin,
    @Req() req: Request,
  ): Promise<PluginResponse> {
    return this.plugins.activate(ctxOf(user, tenant, req), id, body);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  pause(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<PluginResponse> {
    return this.plugins.pause(ctxOf(user, tenant, req), id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  revoke(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(revokePluginSchema)) body: RevokePlugin,
    @Req() req: Request,
  ): Promise<PluginResponse> {
    return this.plugins.revoke(ctxOf(user, tenant, req), id, body);
  }

  @Get(':id/versions')
  @RequirePermission('ai.manage')
  versions(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<PluginVersionResponse[]> {
    return this.plugins.versions(ctxOf(user, tenant, req), id);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  restore(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('versionId', new ParseUUIDPipe()) versionId: string,
    @Req() req: Request,
  ): Promise<PluginResponse> {
    return this.plugins.restoreVersion(ctxOf(user, tenant, req), id, versionId);
  }

  @Get(':id/export')
  @RequirePermission('ai.manage')
  export(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<PluginManifest> {
    return this.plugins.export(ctxOf(user, tenant, req), id);
  }
}
