import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuditLogResponse, AuditVerifyResponse } from '@maris/contracts';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { AuditService } from './audit.service';

const listQuery = z.object({
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('audit-logs')
@UseGuards(AuthGuard, TenantGuard)
export class AuditController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('audit.read')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>,
  ): Promise<AuditLogResponse[]> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, (tx) => this.audit.list(tx, tenant.id, q));
  }

  @Get('verify')
  @RequirePermission('audit.read')
  verify(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext): Promise<AuditVerifyResponse> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, (tx) => this.audit.verify(tx, tenant.id));
  }
}
