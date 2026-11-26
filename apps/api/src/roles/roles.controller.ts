import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Request } from 'express';
import { schema } from '@maris/db';
import {
  PERMISSIONS,
  updateRolePermissionsSchema,
  type PermissionKey,
  type RoleResponse,
  type UpdateRolePermissions,
} from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { AuditService } from '../audit/audit.service';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { DbService, type Tx } from '../db/db.service';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';

const { roles, rolePermissions, permissions } = schema;

@Controller()
@UseGuards(AuthGuard, TenantGuard)
export class RolesController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('permissions')
  @RequirePermission('roles.read')
  listPermissions() {
    return this.db.db.select().from(permissions).orderBy(asc(permissions.key));
  }

  @Get('roles')
  @RequirePermission('roles.read')
  list(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext): Promise<RoleResponse[]> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, (tx) => this.loadRoles(tx, tenant.id));
  }

  @Put('roles/:id/permissions')
  @RequirePermission('roles.manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) roleId: string,
    @Body(new ZodPipe(updateRolePermissionsSchema)) body: UpdateRolePermissions,
    @Req() req: Request,
  ): Promise<RoleResponse> {
    const unknown = body.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p));
    if (unknown.length) {
      throw new BadRequestException({ code: 'UNKNOWN_PERMISSION', message: 'Quyền không tồn tại', details: unknown });
    }
    const wanted = [...new Set(body.permissions)] as PermissionKey[];
    // Nobody can grant a permission they do not hold themselves.
    const escalation = wanted.filter((p) => !tenant.permissions.has(p));
    if (escalation.length) {
      throw new ForbiddenException({ code: 'PERMISSION_ESCALATION', message: 'Không thể cấp quyền bạn không có', details: escalation });
    }

    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const [role] = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenant.id)));
      if (!role) throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Không tìm thấy vai trò' });
      if (role.key === 'owner') {
        throw new ForbiddenException({ code: 'OWNER_ROLE_LOCKED', message: 'Không sửa được quyền của Owner' });
      }
      const before = (await tx.select().from(rolePermissions).where(eq(rolePermissions.roleId, roleId))).map((r) => r.permissionKey);
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
      if (wanted.length) {
        await tx.insert(rolePermissions).values(wanted.map((p) => ({ tenantId: tenant.id, roleId, permissionKey: p })));
      }
      await tx.update(roles).set({ updatedAt: new Date(), version: role.version + 1 }).where(eq(roles.id, roleId));
      await this.audit.append(tx, {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'role.permissions.updated',
        targetType: 'role',
        targetId: roleId,
        metadata: { role: role.key, before: before.sort(), after: [...wanted].sort() },
        ip: clientIp(req),
      });
      const all = await this.loadRoles(tx, tenant.id);
      return all.find((r) => r.id === roleId)!;
    });
  }

  private async loadRoles(tx: Tx, tenantId: string): Promise<RoleResponse[]> {
    const rows = await tx.select().from(roles).where(eq(roles.tenantId, tenantId)).orderBy(asc(roles.createdAt));
    const perms = await tx.select().from(rolePermissions).where(eq(rolePermissions.tenantId, tenantId));
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      builtin: r.builtin,
      permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permissionKey).sort(),
    }));
  }
}
