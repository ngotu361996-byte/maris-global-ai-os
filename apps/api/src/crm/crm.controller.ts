import {
  Body,
  Controller,
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
import {
  addNoteSchema,
  createContactSchema,
  linkThreadSchema,
  listContactsSchema,
  listLeadsSchema,
  updateContactSchema,
  updateLeadFormSchema,
  type AddNote,
  type ContactDetail,
  type ContactResponse,
  type CreateContact,
  type CrmSummaryResponse,
  type LeadFormResponse,
  type LeadResponse,
  type LinkThread,
  type ListContacts,
  type ListLeads,
  type UpdateContact,
  type UpdateLeadForm,
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
import { RateLimit } from '../ratelimit/rate-limit.guard';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { CrmService } from './crm.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

/**
 * CRM (spec Part 20, M25) and Lead Ads. Reading needs crm.read; adding, editing, notes and saving
 * an inbox conversation need crm.manage; reading Meta now and turning forms on or off need
 * meta.manage.
 */
@Controller('crm')
@UseGuards(AuthGuard, TenantGuard)
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  @Get('summary')
  @RequirePermission('crm.read')
  summary(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<CrmSummaryResponse> {
    return this.crm.summary(ctxOf(user, tenant, req));
  }

  @Get('contacts')
  @RequirePermission('crm.read')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listContactsSchema)) query: ListContacts,
  ): Promise<ContactResponse[]> {
    return this.crm.list(ctxOf(user, tenant, req), query);
  }

  @Post('contacts')
  @RequirePermission('crm.manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(createContactSchema)) body: CreateContact,
  ): Promise<ContactDetail> {
    return this.crm.create(ctxOf(user, tenant, req), body);
  }

  @Get('contacts/:id')
  @RequirePermission('crm.read')
  detail(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ContactDetail> {
    return this.crm.detail(ctxOf(user, tenant, req), id);
  }

  @Patch('contacts/:id')
  @RequirePermission('crm.manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateContactSchema)) body: UpdateContact,
  ): Promise<ContactDetail> {
    return this.crm.update(ctxOf(user, tenant, req), id, body);
  }

  @Post('contacts/:id/notes')
  @RequirePermission('crm.manage')
  note(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(addNoteSchema)) body: AddNote,
  ): Promise<ContactDetail> {
    return this.crm.addNote(ctxOf(user, tenant, req), id, body);
  }

  @Post('threads/:threadId/contact')
  @HttpCode(200)
  @RequirePermission('crm.manage')
  linkThread(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Body(new ZodPipe(linkThreadSchema)) body: LinkThread,
  ): Promise<ContactDetail> {
    return this.crm.linkThread(ctxOf(user, tenant, req), threadId, body);
  }

  @Get('leads')
  @RequirePermission('crm.read')
  leads(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listLeadsSchema)) query: ListLeads,
  ): Promise<LeadResponse[]> {
    return this.crm.leadsList(ctxOf(user, tenant, req), query);
  }

  @Get('lead-forms')
  @RequirePermission('crm.read')
  forms(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<LeadFormResponse[]> {
    return this.crm.forms(ctxOf(user, tenant, req));
  }

  @Patch('lead-forms/:id')
  @RequirePermission('meta.manage')
  updateForm(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateLeadFormSchema)) body: UpdateLeadForm,
  ): Promise<LeadFormResponse[]> {
    return this.crm.updateForm(ctxOf(user, tenant, req), id, body);
  }

  @Post('leads/sync')
  @HttpCode(200)
  @RequirePermission('meta.manage')
  @RateLimit({ name: 'crm-leads-sync', limit: 6, windowSec: 600, by: 'ip' })
  sync(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<CrmSummaryResponse & { added: number }> {
    return this.crm.syncLeads(ctxOf(user, tenant, req));
  }
}
