import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  copyWorkflowSchema,
  createWorkflowSchema,
  importWorkflowSchema,
  startWorkflowRunSchema,
  testWorkflowSchema,
  updateWorkflowSchema,
  workflowDecisionSchema,
  WORKFLOW_TEMPLATES,
  type CopyWorkflow,
  type CreateWorkflow,
  type ImportWorkflow,
  type StartWorkflowRun,
  type TestWorkflow,
  type UpdateWorkflow,
  type WorkflowDecision,
  type WorkflowGraph,
  type WorkflowManifest,
  type WorkflowResponse,
  type WorkflowRunDetailResponse,
  type WorkflowRunResponse,
  type WorkflowTemplate,
  type WorkflowTestResponse,
  type WorkflowVersionResponse,
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
import type { Ctx } from '../ai/chat.service';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsService } from './workflows.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});
const uuid = () => new ParseUUIDPipe();

/** Workflow Studio. Managers design workflows; starting a run or answering an approval step needs ai.approve. */
@Controller('workflows')
@UseGuards(AuthGuard, TenantGuard)
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly runs: WorkflowRunsService,
  ) {}

  @Get()
  @RequirePermission('ai.chat')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<WorkflowResponse[]> {
    return this.workflows.list(ctxOf(user, tenant, req));
  }

  @Get('templates')
  @RequirePermission('ai.chat')
  templates(): readonly WorkflowTemplate[] {
    return WORKFLOW_TEMPLATES;
  }

  @Post('templates')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  installTemplates(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ) {
    return this.workflows.installTemplates(ctxOf(user, tenant, req));
  }

  @Post()
  @RequirePermission('ai.manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createWorkflowSchema)) body: CreateWorkflow,
    @Req() req: Request,
  ): Promise<WorkflowResponse> {
    return this.workflows.create(
      ctxOf(user, tenant, req),
      body as CreateWorkflow & { graph: WorkflowGraph },
    );
  }

  @Post('import')
  @RequirePermission('ai.manage')
  import(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(importWorkflowSchema)) body: ImportWorkflow,
    @Req() req: Request,
  ): Promise<WorkflowResponse> {
    return this.workflows.import(ctxOf(user, tenant, req), body);
  }

  @Get('runs/:runId')
  @RequirePermission('ai.chat')
  run(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('runId', uuid()) runId: string,
    @Req() req: Request,
  ): Promise<WorkflowRunDetailResponse> {
    return this.runs.get(ctxOf(user, tenant, req), runId);
  }

  @Post('runs/:runId/approve')
  @HttpCode(200)
  @RequirePermission('ai.approve')
  approve(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('runId', uuid()) runId: string,
    @Body(new ZodPipe(workflowDecisionSchema)) body: WorkflowDecision,
    @Req() req: Request,
  ): Promise<WorkflowRunDetailResponse> {
    return this.runs.approve(ctxOf(user, tenant, req), runId, body.note);
  }

  @Post('runs/:runId/reject')
  @HttpCode(200)
  @RequirePermission('ai.approve')
  reject(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('runId', uuid()) runId: string,
    @Body(new ZodPipe(workflowDecisionSchema)) body: WorkflowDecision,
    @Req() req: Request,
  ): Promise<WorkflowRunDetailResponse> {
    return this.runs.reject(ctxOf(user, tenant, req), runId, body.note);
  }

  @Post('runs/:runId/pause')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  pause(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('runId', uuid()) runId: string,
    @Req() req: Request,
  ): Promise<WorkflowRunDetailResponse> {
    return this.runs.pause(ctxOf(user, tenant, req), runId, tenant.permissions.has('ai.approve'));
  }

  @Post('runs/:runId/resume')
  @HttpCode(200)
  @RequirePermission('ai.approve')
  resume(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('runId', uuid()) runId: string,
    @Req() req: Request,
  ): Promise<WorkflowRunDetailResponse> {
    return this.runs.resume(ctxOf(user, tenant, req), runId);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  cancel(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('runId', uuid()) runId: string,
    @Req() req: Request,
  ): Promise<WorkflowRunDetailResponse> {
    return this.runs.cancel(ctxOf(user, tenant, req), runId, tenant.permissions.has('ai.approve'));
  }

  @Post('runs/:runId/restore')
  @HttpCode(200)
  @RequirePermission('ai.approve')
  restore(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('runId', uuid()) runId: string,
    @Req() req: Request,
  ): Promise<WorkflowRunDetailResponse> {
    return this.runs.restore(ctxOf(user, tenant, req), runId);
  }

  @Get(':id')
  @RequirePermission('ai.chat')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Req() req: Request,
  ): Promise<WorkflowResponse> {
    return this.workflows.get(ctxOf(user, tenant, req), id);
  }

  @Patch(':id')
  @RequirePermission('ai.manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Body(new ZodPipe(updateWorkflowSchema)) body: UpdateWorkflow,
    @Req() req: Request,
  ): Promise<WorkflowResponse> {
    return this.workflows.update(
      ctxOf(user, tenant, req),
      id,
      body as UpdateWorkflow & { graph?: WorkflowGraph },
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('ai.manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.workflows.remove(ctxOf(user, tenant, req), id);
  }

  @Get(':id/versions')
  @RequirePermission('ai.chat')
  versions(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Req() req: Request,
  ): Promise<WorkflowVersionResponse[]> {
    return this.workflows.versions(ctxOf(user, tenant, req), id);
  }

  @Post(':id/versions/:version/restore')
  @HttpCode(200)
  @RequirePermission('ai.manage')
  restoreVersion(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() req: Request,
  ): Promise<WorkflowResponse> {
    return this.workflows.restoreVersion(ctxOf(user, tenant, req), id, version);
  }

  @Post(':id/copy')
  @RequirePermission('ai.manage')
  copy(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Body(new ZodPipe(copyWorkflowSchema)) body: CopyWorkflow,
    @Req() req: Request,
  ): Promise<WorkflowResponse> {
    return this.workflows.copy(ctxOf(user, tenant, req), id, body);
  }

  @Get(':id/export')
  @RequirePermission('ai.chat')
  export(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Req() req: Request,
  ): Promise<WorkflowManifest> {
    return this.workflows.export(ctxOf(user, tenant, req), id);
  }

  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission('ai.chat')
  test(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Body(new ZodPipe(testWorkflowSchema)) body: TestWorkflow,
    @Req() req: Request,
  ): Promise<WorkflowTestResponse> {
    return this.runs.test(ctxOf(user, tenant, req), id, body);
  }

  @Get(':id/runs')
  @RequirePermission('ai.chat')
  listRuns(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Req() req: Request,
  ): Promise<WorkflowRunResponse[]> {
    return this.runs.list(ctxOf(user, tenant, req), id);
  }

  @Post(':id/runs')
  @RequirePermission('ai.approve')
  start(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', uuid()) id: string,
    @Body(new ZodPipe(startWorkflowRunSchema)) body: StartWorkflowRun,
    @Req() req: Request,
  ): Promise<WorkflowRunDetailResponse> {
    return this.runs.start(ctxOf(user, tenant, req), id, body);
  }
}
