import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createTaskSchema,
  emergencyStopSchema,
  TASK_STATUSES,
  taskDecisionSchema,
  upsertBudgetSchema,
  type AiActivityResponse,
  type AiControlResponse,
  type BudgetResponse,
  type CreateTask,
  type EmergencyStop,
  type TaskDecision,
  type TaskResponse,
  type UpsertBudget,
} from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import type { Ctx } from './chat.service';
import { ControlService } from './control.service';
import { CostGovernorService } from './cost-governor.service';
import { TasksService } from './tasks.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({ tenantId: tenant.id, userId: user.id, ip: clientIp(req) });
const listQuery = z.object({ status: z.enum(TASK_STATUSES).optional() });

@Controller('ai')
@UseGuards(AuthGuard, TenantGuard)
export class TasksController {
  constructor(
    private readonly db: DbService,
    private readonly tasks: TasksService,
    private readonly control: ControlService,
    private readonly governor: CostGovernorService,
  ) {}

  // ---------- tasks ----------

  @Get('tasks')
  @RequirePermission('ai.chat')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>,
    @Req() req: Request,
  ): Promise<TaskResponse[]> {
    return this.tasks.list(ctxOf(user, tenant, req), q.status);
  }

  @Get('tasks/:id')
  @RequirePermission('ai.chat')
  get(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.tasks.get(ctxOf(user, tenant, req), id);
  }

  @Post('tasks')
  @RequirePermission('ai.chat')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createTaskSchema)) body: CreateTask,
    @Req() req: Request,
  ): Promise<TaskResponse> {
    return this.tasks.create(ctxOf(user, tenant, req), body);
  }

  @Post('tasks/:id/approve')
  @HttpCode(200)
  @RequirePermission('ai.approve')
  approve(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(taskDecisionSchema)) body: TaskDecision,
    @Req() req: Request,
  ): Promise<TaskResponse> {
    return this.tasks.approve(ctxOf(user, tenant, req), id, body.note || null);
  }

  @Post('tasks/:id/reject')
  @HttpCode(200)
  @RequirePermission('ai.approve')
  reject(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(taskDecisionSchema)) body: TaskDecision,
    @Req() req: Request,
  ): Promise<TaskResponse> {
    return this.tasks.reject(ctxOf(user, tenant, req), id, body.note || null);
  }

  @Post('tasks/:id/pause')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  pause(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.tasks.pause(ctxOf(user, tenant, req), id, tenant.permissions.has('ai.approve'));
  }

  @Post('tasks/:id/resume')
  @HttpCode(200)
  @RequirePermission('ai.approve')
  resume(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.tasks.resume(ctxOf(user, tenant, req), id);
  }

  @Post('tasks/:id/cancel')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  cancel(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    return this.tasks.cancel(ctxOf(user, tenant, req), id, tenant.permissions.has('ai.approve'));
  }

  @Get('activity')
  @RequirePermission('ai.chat')
  activity(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Req() req: Request): Promise<AiActivityResponse> {
    return this.tasks.activity(ctxOf(user, tenant, req));
  }

  // ---------- emergency stop ----------

  @Get('emergency-stop')
  @RequirePermission('ai.chat')
  stopState(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext): Promise<AiControlResponse> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, (tx) => this.control.state(tx, tenant.id));
  }

  /** Anyone who can use AI may stop it; turning it back on needs ai.approve. */
  @Post('emergency-stop')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  async stop(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(emergencyStopSchema)) body: EmergencyStop,
    @Req() req: Request,
  ): Promise<AiControlResponse> {
    const ctx = ctxOf(user, tenant, req);
    const state = await this.db.withContext(ctx, (tx) => this.control.stop(tx, ctx, body.reason || null));
    await this.control.publish(tenant.id, true);
    return state;
  }

  @Delete('emergency-stop')
  @RequirePermission('ai.approve')
  async release(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Req() req: Request): Promise<AiControlResponse> {
    const ctx = ctxOf(user, tenant, req);
    const state = await this.db.withContext(ctx, (tx) => this.control.resume(tx, ctx));
    await this.control.publish(tenant.id, false);
    return state;
  }

  // ---------- budgets ----------

  @Get('budgets')
  @RequirePermission('ai.chat')
  budgets(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext): Promise<BudgetResponse[]> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, (tx) => this.governor.list(tx, tenant.id));
  }

  @Put('budgets')
  @RequirePermission('ai.manage')
  setBudget(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(upsertBudgetSchema)) body: UpsertBudget,
    @Req() req: Request,
  ): Promise<BudgetResponse> {
    const ctx = ctxOf(user, tenant, req);
    return this.db.withContext(ctx, (tx) => this.governor.upsert(tx, ctx, body));
  }

  @Delete('budgets/:id')
  @HttpCode(204)
  @RequirePermission('ai.manage')
  removeBudget(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    const ctx = ctxOf(user, tenant, req);
    return this.db.withContext(ctx, (tx) => this.governor.remove(tx, ctx, id));
  }
}
