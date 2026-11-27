import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { createPlanSchema, type CreatePlan, type PlanDetailResponse, type PlanResponse } from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import type { Ctx } from './chat.service';
import { PlansService } from './plans.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({ tenantId: tenant.id, userId: user.id, ip: clientIp(req) });

/** AI Central Command: plans made from a business goal. */
@Controller('ai/plans')
@UseGuards(AuthGuard, TenantGuard)
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @RequirePermission('ai.chat')
  list(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Req() req: Request): Promise<PlanResponse[]> {
    return this.plans.list(ctxOf(user, tenant, req));
  }

  @Get(':id')
  @RequirePermission('ai.chat')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<PlanDetailResponse> {
    return this.plans.get(ctxOf(user, tenant, req), id);
  }

  @Post()
  @RequirePermission('ai.chat')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createPlanSchema)) body: CreatePlan,
    @Req() req: Request,
  ): Promise<PlanResponse> {
    return this.plans.create(ctxOf(user, tenant, req), body);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  accept(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<PlanDetailResponse> {
    return this.plans.accept(ctxOf(user, tenant, req), id, tenant.permissions.has('ai.approve'));
  }

  @Post(':id/discard')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  discard(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<PlanResponse> {
    return this.plans.discard(ctxOf(user, tenant, req), id, tenant.permissions.has('ai.approve'));
  }

  @Post(':id/report')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  report(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<PlanResponse> {
    return this.plans.report(ctxOf(user, tenant, req), id);
  }
}
