import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { z } from 'zod';
import {
  createDeviceSchema,
  heartbeatSchema,
  pairDeviceSchema,
  updateDeviceSchema,
  type CreateDevice,
  type DeviceEventResponse,
  type DeviceMetricResponse,
  type DevicePairingResponse,
  type DeviceResponse,
  type Heartbeat,
  type HeartbeatResponse,
  type PairDevice,
  type PairDeviceResponse,
  type ServerStatusResponse,
  type UpdateDevice,
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
import { DevicesService } from './devices.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

const metricsQuery = z.object({
  minutes: z.coerce.number().int().min(1).max(1440).default(60),
});

/** Devices and workers, for people with a session (spec Part 26). */
@Controller('devices')
@UseGuards(AuthGuard, TenantGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @RequirePermission('infra.read')
  list(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<DeviceResponse[]> {
    return this.devices.list(ctxOf(user, tenant, req));
  }

  @Get('server')
  @RequirePermission('infra.read')
  server(): Promise<ServerStatusResponse> {
    return this.devices.server();
  }

  @Post()
  @RequirePermission('infra.manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createDeviceSchema)) body: CreateDevice,
    @Req() req: Request,
  ): Promise<DevicePairingResponse> {
    return this.devices.create(ctxOf(user, tenant, req), body);
  }

  @Get(':id')
  @RequirePermission('infra.read')
  get(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<DeviceResponse> {
    return this.devices.get(ctxOf(user, tenant, req), id);
  }

  @Get(':id/metrics')
  @RequirePermission('infra.read')
  metrics(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodPipe(metricsQuery)) q: z.infer<typeof metricsQuery>,
    @Req() req: Request,
  ): Promise<DeviceMetricResponse[]> {
    return this.devices.metrics(ctxOf(user, tenant, req), id, q.minutes);
  }

  @Get(':id/events')
  @RequirePermission('infra.read')
  events(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<DeviceEventResponse[]> {
    return this.devices.events(ctxOf(user, tenant, req), id);
  }

  @Post(':id/pairing')
  @RequirePermission('infra.manage')
  newPairing(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<DevicePairingResponse> {
    return this.devices.newPairing(ctxOf(user, tenant, req), id);
  }

  @Patch(':id')
  @RequirePermission('infra.manage')
  update(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateDeviceSchema)) body: UpdateDevice,
    @Req() req: Request,
  ): Promise<DeviceResponse> {
    return this.devices.update(ctxOf(user, tenant, req), id, body);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @RequirePermission('infra.manage')
  pause(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<DeviceResponse> {
    return this.devices.setPaused(ctxOf(user, tenant, req), id, true);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission('infra.manage')
  resume(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<DeviceResponse> {
    return this.devices.setPaused(ctxOf(user, tenant, req), id, false);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('infra.manage')
  revoke(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<DeviceResponse> {
    return this.devices.revoke(ctxOf(user, tenant, req), id);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('infra.manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.devices.remove(ctxOf(user, tenant, req), id);
  }
}

/**
 * Public endpoints for the worker program. No session: the pairing string, then the device key in
 * X-Maris-Device, is the credential. The worker always calls in; nothing here runs a command.
 */
@Controller('agent')
export class DeviceAgentController {
  constructor(private readonly devices: DevicesService) {}

  @Post('pair')
  @HttpCode(200)
  @RateLimit({ name: 'agent-pair', limit: 10, windowSec: 60, by: 'ip' })
  pair(
    @Body(new ZodPipe(pairDeviceSchema)) body: PairDevice,
    @Req() req: Request,
  ): Promise<PairDeviceResponse> {
    return this.devices.pair(body, clientIp(req));
  }

  @Post('heartbeat')
  @HttpCode(200)
  @RateLimit({ name: 'agent-heartbeat', limit: 240, windowSec: 60, by: 'ip' })
  heartbeat(
    @Headers('x-maris-device') key: string | undefined,
    @Body(new ZodPipe(heartbeatSchema)) body: Heartbeat,
    @Req() req: Request,
  ): Promise<HeartbeatResponse> {
    return this.devices.heartbeat(key, body, clientIp(req));
  }
}
