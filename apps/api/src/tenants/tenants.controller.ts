import { Controller, Get, NotFoundException, UseGuards } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { schema } from '@maris/db';
import type { MemberResponse, TenantResponse } from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { DbService } from '../db/db.service';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';

const { tenants, tenantMembers, users, roles } = schema;

@Controller('tenants/current')
@UseGuards(AuthGuard, TenantGuard)
export class TenantsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequirePermission('tenant.read')
  current(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext): Promise<TenantResponse> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const [t] = await tx.select().from(tenants).where(eq(tenants.id, tenant.id));
      if (!t) throw new NotFoundException();
      return { id: t.id, name: t.name, slug: t.slug, createdAt: t.createdAt.toISOString() };
    });
  }

  @Get('members')
  @RequirePermission('members.read')
  members(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext): Promise<MemberResponse[]> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const rows = await tx
        .select({
          userId: users.id,
          email: users.email,
          displayName: users.displayName,
          role: roles.key,
          joinedAt: tenantMembers.createdAt,
        })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .innerJoin(roles, eq(roles.id, tenantMembers.roleId))
        .where(eq(tenantMembers.tenantId, tenant.id))
        .orderBy(asc(tenantMembers.createdAt));
      return rows.map((r) => ({ ...r, joinedAt: r.joinedAt.toISOString() }));
    });
  }
}
