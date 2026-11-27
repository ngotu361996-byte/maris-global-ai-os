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
  createCouncilSchema,
  createModelSchema,
  updateModelSchema,
  type CouncilDetailResponse,
  type CouncilResponse,
  type CreateCouncil,
  type CreateModel,
  type ModelResponse,
  type UpdateModel,
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
import { DbService } from '../db/db.service';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import type { Ctx } from './chat.service';
import { CouncilService } from './council.service';
import { ModelsService } from './models.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

@Controller('ai')
@UseGuards(AuthGuard, TenantGuard)
export class CouncilController {
  constructor(
    private readonly db: DbService,
    private readonly council: CouncilService,
    private readonly models: ModelsService,
  ) {}

  // ---------- AI Council ----------

  @Get('councils')
  @RequirePermission('ai.chat')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<CouncilResponse[]> {
    return this.council.list(ctxOf(user, tenant, req));
  }

  @Get('councils/:id')
  @RequirePermission('ai.chat')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<CouncilDetailResponse> {
    return this.council.get(ctxOf(user, tenant, req), id);
  }

  @Post('councils')
  @RequirePermission('ai.chat')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createCouncilSchema)) body: CreateCouncil,
    @Req() req: Request,
  ): Promise<CouncilResponse> {
    return this.council.create(ctxOf(user, tenant, req), body);
  }

  @Post('councils/:id/cancel')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  cancel(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<CouncilResponse> {
    return this.council.cancel(ctxOf(user, tenant, req), id, tenant.permissions.has('ai.approve'));
  }

  // ---------- Model Registry ----------

  @Get('models')
  @RequirePermission('ai.chat')
  listModels(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<ModelResponse[]> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, (tx) =>
      this.models.list(tx, tenant.id),
    );
  }

  @Post('models')
  @RequirePermission('ai.manage')
  createModel(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createModelSchema)) body: CreateModel,
    @Req() req: Request,
  ): Promise<ModelResponse> {
    const ctx = ctxOf(user, tenant, req);
    return this.db.withContext(ctx, (tx) => this.models.create(tx, ctx, body));
  }

  @Patch('models/:id')
  @RequirePermission('ai.manage')
  updateModel(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateModelSchema)) body: UpdateModel,
    @Req() req: Request,
  ): Promise<ModelResponse> {
    const ctx = ctxOf(user, tenant, req);
    return this.db.withContext(ctx, (tx) => this.models.update(tx, ctx, id, body));
  }

  @Delete('models/:id')
  @HttpCode(204)
  @RequirePermission('ai.manage')
  removeModel(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    const ctx = ctxOf(user, tenant, req);
    return this.db.withContext(ctx, (tx) => this.models.remove(tx, ctx, id));
  }
}
