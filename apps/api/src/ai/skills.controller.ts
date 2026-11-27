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
  createSkillSchema,
  importSkillSchema,
  runSkillSchema,
  SKILL_TEMPLATES,
  updateSkillSchema,
  type CreateSkill,
  type ImportSkill,
  type RunSkill,
  type SkillField,
  type SkillManifest,
  type SkillResponse,
  type SkillTemplate,
  type TaskResponse,
  type UpdateSkill,
} from '@maris/contracts';
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
import type { Ctx } from './chat.service';
import { SkillsService } from './skills.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/** Skills: packaged AI work that anyone with chat access can run and only managers can change. */
@Controller('ai/skills')
@UseGuards(AuthGuard, TenantGuard)
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @RequirePermission('ai.chat')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<SkillResponse[]> {
    return this.skills.list(ctxOf(user, tenant, req));
  }

  @Get('templates')
  @RequirePermission('ai.chat')
  templates(): readonly SkillTemplate[] {
    return SKILL_TEMPLATES;
  }

  @Post('templates')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  installTemplates(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<SkillResponse[]> {
    return this.skills.installTemplates(ctxOf(user, tenant, req));
  }

  @Post()
  @RequirePermission('ai.manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createSkillSchema)) body: CreateSkill,
    @Req() req: Request,
  ): Promise<SkillResponse> {
    return this.skills.create(
      ctxOf(user, tenant, req),
      body as CreateSkill & { inputs: SkillField[] },
    );
  }

  @Post('import')
  @RequirePermission('ai.manage')
  import(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(importSkillSchema)) body: ImportSkill,
    @Req() req: Request,
  ): Promise<SkillResponse> {
    return this.skills.import(ctxOf(user, tenant, req), body);
  }

  @Patch(':id')
  @RequirePermission('ai.manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateSkillSchema)) body: UpdateSkill,
    @Req() req: Request,
  ): Promise<SkillResponse> {
    return this.skills.update(ctxOf(user, tenant, req), id, body);
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
    await this.skills.remove(ctxOf(user, tenant, req), id);
  }

  @Get(':id/export')
  @RequirePermission('ai.chat')
  export(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<SkillManifest> {
    return this.skills.export(ctxOf(user, tenant, req), id);
  }

  @Post(':id/run')
  @RequirePermission('ai.chat')
  run(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(runSkillSchema)) body: RunSkill,
    @Req() req: Request,
  ): Promise<TaskResponse> {
    return this.skills.run(ctxOf(user, tenant, req), id, body);
  }
}
