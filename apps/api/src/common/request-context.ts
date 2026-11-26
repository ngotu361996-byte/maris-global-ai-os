import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { PermissionKey } from '@maris/contracts';

export interface AuthUser {
  id: string;
  email: string;
  sessionId: string;
}

export interface TenantContext {
  id: string;
  roleId: string;
  roleKey: string;
  permissions: Set<PermissionKey>;
}

export interface MarisRequest extends Request {
  user?: AuthUser;
  tenant?: TenantContext;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const user = ctx.switchToHttp().getRequest<MarisRequest>().user;
  if (!user) throw new Error('CurrentUser used without AuthGuard');
  return user;
});

export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantContext => {
  const tenant = ctx.switchToHttp().getRequest<MarisRequest>().tenant;
  if (!tenant) throw new Error('CurrentTenant used without TenantGuard');
  return tenant;
});

export function clientIp(req: Request): string | null {
  return req.ip ?? null;
}
