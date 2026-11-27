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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  callConnectorSchema,
  CONNECTOR_TEMPLATES,
  createConnectorSchema,
  importConnectorSchema,
  updateConnectorSchema,
  type CallConnector,
  type ConnectorCallResponse,
  type ConnectorManifest,
  type ConnectorResponse,
  type ConnectorTemplate,
  type ConnectorTokenResponse,
  type CreateConnector,
  type ImportConnector,
  type UpdateConnector,
  type WebhookEventResponse,
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
import { ConnectorsService } from './connectors.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/**
 * Connector Hub. Managers set connectors up and try read capabilities; turning one on, and trying
 * a capability that sends or changes something outside, need ai.approve.
 */
@Controller('connectors')
@UseGuards(AuthGuard, TenantGuard)
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get()
  @RequirePermission('ai.chat')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<ConnectorResponse[]> {
    return this.connectors.list(ctxOf(user, tenant, req));
  }

  @Get('templates')
  @RequirePermission('ai.manage')
  templates(): readonly ConnectorTemplate[] {
    return CONNECTOR_TEMPLATES;
  }

  @Post('templates')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  installTemplates(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<ConnectorResponse[]> {
    return this.connectors.installTemplates(ctxOf(user, tenant, req));
  }

  @Post()
  @RequirePermission('ai.manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createConnectorSchema)) body: CreateConnector,
    @Req() req: Request,
  ): Promise<ConnectorResponse> {
    return this.connectors.create(ctxOf(user, tenant, req), body);
  }

  @Post('import')
  @RequirePermission('ai.manage')
  import(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(importConnectorSchema)) body: ImportConnector,
    @Req() req: Request,
  ): Promise<ConnectorResponse> {
    return this.connectors.import(ctxOf(user, tenant, req), body);
  }

  @Get(':id')
  @RequirePermission('ai.manage')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ConnectorResponse> {
    return this.connectors.get(ctxOf(user, tenant, req), id);
  }

  @Patch(':id')
  @RequirePermission('ai.manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateConnectorSchema)) body: UpdateConnector,
    @Req() req: Request,
  ): Promise<ConnectorResponse> {
    return this.connectors.update(ctxOf(user, tenant, req), id, body);
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
    await this.connectors.remove(ctxOf(user, tenant, req), id);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('ai.approve')
  activate(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ConnectorResponse> {
    return this.connectors.activate(ctxOf(user, tenant, req), id);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  pause(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ConnectorResponse> {
    return this.connectors.pause(ctxOf(user, tenant, req), id);
  }

  @Post(':id/token')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  rotateToken(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ConnectorTokenResponse> {
    return this.connectors.rotateToken(ctxOf(user, tenant, req), id);
  }

  @Get(':id/export')
  @RequirePermission('ai.manage')
  export(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ConnectorManifest> {
    return this.connectors.export(ctxOf(user, tenant, req), id);
  }

  @Post(':id/call')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  call(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(callConnectorSchema)) body: CallConnector,
    @Req() req: Request,
  ): Promise<ConnectorCallResponse> {
    return this.connectors.call(
      ctxOf(user, tenant, req),
      id,
      body,
      tenant.permissions.has('ai.approve'),
    );
  }

  @Get(':id/calls')
  @RequirePermission('ai.manage')
  calls(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<ConnectorCallResponse[]> {
    return this.connectors.calls(ctxOf(user, tenant, req), id);
  }

  @Get(':id/events')
  @RequirePermission('ai.manage')
  events(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<WebhookEventResponse[]> {
    return this.connectors.events(ctxOf(user, tenant, req), id);
  }
}
