import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  AGENT_TEMPLATES,
  createAgentSchema,
  installAgentTemplatesSchema,
  updateAgentSchema,
  type AgentResponse,
  type AgentTemplate,
  type AgentVersionResponse,
  type CreateAgent,
  type InstallAgentTemplates,
  type UpdateAgent,
} from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { AgentsService } from './agents.service';
import type { Ctx } from './chat.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({ tenantId: tenant.id, userId: user.id, ip: clientIp(req) });

@Controller('ai/agents')
@UseGuards(AuthGuard, TenantGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @RequirePermission('ai.chat')
  list(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Req() req: Request): Promise<AgentResponse[]> {
    return this.agents.list(ctxOf(user, tenant, req));
  }

  @Get('templates')
  @RequirePermission('ai.chat')
  templates(): readonly AgentTemplate[] {
    return AGENT_TEMPLATES;
  }

  @Post('templates')
  @RequirePermission('ai.manage')
  install(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(installAgentTemplatesSchema)) body: InstallAgentTemplates,
    @Req() req: Request,
  ): Promise<AgentResponse[]> {
    return this.agents.installTemplates(ctxOf(user, tenant, req), body.keys);
  }

  @Post()
  @RequirePermission('ai.manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createAgentSchema)) body: CreateAgent,
    @Req() req: Request,
  ): Promise<AgentResponse> {
    return this.agents.create(ctxOf(user, tenant, req), body);
  }

  @Get(':id/versions')
  @RequirePermission('ai.chat')
  versions(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<AgentVersionResponse[]> {
    return this.agents.versions(ctxOf(user, tenant, req), id);
  }

  @Patch(':id')
  @RequirePermission('ai.manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateAgentSchema)) body: UpdateAgent,
    @Req() req: Request,
  ): Promise<AgentResponse> {
    return this.agents.update(ctxOf(user, tenant, req), id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('ai.manage')
  remove(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.agents.remove(ctxOf(user, tenant, req), id);
  }
}
