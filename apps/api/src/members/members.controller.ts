import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';
import {
  acceptInvitationSchema,
  changeMemberRoleSchema,
  createInvitationSchema,
  type AcceptInvitation,
  type ChangeMemberRole,
  type CreateInvitation,
  type InvitationResponse,
} from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { sessionTokenFrom, setSessionCookie, wantsCookie } from '../auth/session-cookie';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { RateLimit } from '../ratelimit/rate-limit.guard';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { MembersService } from './members.service';

@Controller()
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('tenants/current/invitations')
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.manage')
  invite(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createInvitationSchema)) body: CreateInvitation,
    @Req() req: Request,
  ): Promise<InvitationResponse> {
    return this.members.invite({ user, tenant, ip: clientIp(req) }, body.email, body.roleId);
  }

  @Get('tenants/current/invitations')
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.read')
  list(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext, @Req() req: Request) {
    return this.members.listInvitations({ user, tenant, ip: clientIp(req) });
  }

  @Delete('tenants/current/invitations/:id')
  @HttpCode(204)
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.manage')
  revoke(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.members.revokeInvitation({ user, tenant, ip: clientIp(req) }, id);
  }

  @Patch('tenants/current/members/:userId')
  @HttpCode(204)
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.manage')
  changeRole(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodPipe(changeMemberRoleSchema)) body: ChangeMemberRole,
    @Req() req: Request,
  ) {
    return this.members.changeRole({ user, tenant, ip: clientIp(req) }, userId, body.roleId);
  }

  @Delete('tenants/current/members/:userId')
  @HttpCode(204)
  @UseGuards(AuthGuard, TenantGuard)
  @RequirePermission('members.manage')
  remove(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ) {
    return this.members.remove({ user, tenant, ip: clientIp(req) }, userId);
  }

  /** Public: the invitee may not have an account yet. A session, if present, identifies an existing account. */
  @Post('invitations/accept')
  @HttpCode(200)
  @RateLimit({ name: 'invite-accept', limit: 20, windowSec: 900, by: 'ip' })
  async accept(
    @Body(new ZodPipe(acceptInvitationSchema)) body: AcceptInvitation,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = sessionTokenFrom(req);
    const sessionUser = token ? await this.auth.resolveSession(token) : null;
    const result = await this.members.accept(body, sessionUser, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    if ('token' in result && wantsCookie(req)) {
      setSessionCookie(res, result.token, new Date(result.expiresAt), this.config.NODE_ENV === 'production');
      return { expiresAt: result.expiresAt };
    }
    return result;
  }
}
