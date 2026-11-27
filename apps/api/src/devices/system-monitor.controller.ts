import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { SystemMonitorResponse } from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import {
  clientIp,
  CurrentTenant,
  CurrentUser,
  type AuthUser,
  type TenantContext,
} from '../common/request-context';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { SystemMonitorService } from './system-monitor.service';

/** System monitoring for people who can see infrastructure. */
@Controller('system')
@UseGuards(AuthGuard, TenantGuard)
export class SystemMonitorController {
  constructor(private readonly monitor: SystemMonitorService) {}

  @Get('monitor')
  @RequirePermission('infra.read')
  snapshot(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<SystemMonitorResponse> {
    return this.monitor.snapshot({ tenantId: tenant.id, userId: user.id, ip: clientIp(req) });
  }
}
