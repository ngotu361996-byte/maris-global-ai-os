import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import { schema } from '@maris/db';
import type { PermissionKey } from '@maris/contracts';
import type { MarisRequest } from '../common/request-context';
import { DbService } from '../db/db.service';

const PERMISSION_KEY = 'maris:permission';
export const RequirePermission = (permission: PermissionKey) => SetMetadata(PERMISSION_KEY, permission);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { tenantMembers, roles, rolePermissions } = schema;

/**
 * Resolves the X-Tenant-Id header to a tenant the signed-in user is a member of,
 * loads that membership's permissions, then enforces @RequirePermission.
 * The header is only a choice among the user's own tenants; it is never trusted alone.
 * Must run after AuthGuard.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly db: DbService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<MarisRequest>();
    const user = req.user;
    if (!user) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Thiếu phiên đăng nhập' });
    const tenantId = req.headers['x-tenant-id'];
    if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
      throw new ForbiddenException({ code: 'TENANT_REQUIRED', message: 'Thiếu hoặc sai X-Tenant-Id' });
    }

    const membership = await this.db.withContext({ userId: user.id, tenantId }, async (tx) => {
      const [m] = await tx
        .select({ roleId: tenantMembers.roleId, roleKey: roles.key })
        .from(tenantMembers)
        .innerJoin(roles, eq(roles.id, tenantMembers.roleId))
        .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, user.id)))
        .limit(1);
      if (!m) return null;
      const perms = await tx
        .select({ key: rolePermissions.permissionKey })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, m.roleId));
      return { ...m, permissions: new Set(perms.map((p) => p.key as PermissionKey)) };
    });
    if (!membership) {
      throw new ForbiddenException({ code: 'NOT_A_MEMBER', message: 'Bạn không thuộc Tenant này' });
    }
    req.tenant = { id: tenantId, ...membership };

    const required = this.reflector.getAllAndOverride<PermissionKey | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && !membership.permissions.has(required)) {
      throw new ForbiddenException({ code: 'PERMISSION_DENIED', message: `Thiếu quyền ${required}` });
    }
    return true;
  }
}
