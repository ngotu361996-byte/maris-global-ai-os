import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  createMemorySchema,
  createProjectSchema,
  updateMemorySchema,
  updateProjectSchema,
  type CreateMemory,
  type CreateProject,
  type MemoryResponse,
  type ProjectResponse,
  type UpdateMemory,
  type UpdateProject,
} from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import type { Ctx } from './chat.service';
import { MemoryService } from './memory.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({ tenantId: tenant.id, userId: user.id, ip: clientIp(req) });

/** Projects and their memory. Everyone who can chat can read them; ai.memory can change them. */
@Controller('ai')
@UseGuards(AuthGuard, TenantGuard)
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get('projects')
  @RequirePermission('ai.chat')
  listProjects(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Req() req: Request): Promise<ProjectResponse[]> {
    return this.memory.listProjects(ctxOf(user, tenant, req));
  }

  @Post('projects')
  @RequirePermission('ai.memory')
  createProject(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createProjectSchema)) body: CreateProject,
    @Req() req: Request,
  ): Promise<ProjectResponse> {
    return this.memory.createProject(ctxOf(user, tenant, req), body);
  }

  @Patch('projects/:id')
  @RequirePermission('ai.memory')
  updateProject(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateProjectSchema)) body: UpdateProject,
    @Req() req: Request,
  ): Promise<ProjectResponse> {
    return this.memory.updateProject(ctxOf(user, tenant, req), id, body);
  }

  @Delete('projects/:id')
  @HttpCode(204)
  @RequirePermission('ai.memory')
  removeProject(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.memory.removeProject(ctxOf(user, tenant, req), id);
  }

  @Get('projects/:id/memories')
  @RequirePermission('ai.chat')
  listMemories(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<MemoryResponse[]> {
    return this.memory.listMemories(ctxOf(user, tenant, req), id);
  }

  @Post('projects/:id/memories')
  @RequirePermission('ai.memory')
  createMemory(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(createMemorySchema)) body: CreateMemory,
    @Req() req: Request,
  ): Promise<MemoryResponse> {
    return this.memory.createMemory(ctxOf(user, tenant, req), id, body);
  }

  @Patch('memories/:id')
  @RequirePermission('ai.memory')
  updateMemory(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateMemorySchema)) body: UpdateMemory,
    @Req() req: Request,
  ): Promise<MemoryResponse> {
    return this.memory.updateMemory(ctxOf(user, tenant, req), id, body);
  }

  @Delete('memories/:id')
  @HttpCode(204)
  @RequirePermission('ai.memory')
  removeMemory(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    return this.memory.removeMemory(ctxOf(user, tenant, req), id);
  }
}
