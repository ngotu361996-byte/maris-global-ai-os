import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  connectPoscakeSchema,
  connectShopifySchema,
  listOrdersSchema,
  listVariantsSchema,
  setPriceSchema,
  setStockSchema,
  updateStoreSchema,
  type ApiCallResponse,
  type CommerceChangeResponse,
  type CommerceOrdersResponse,
  type CommerceReportResponse,
  type CommerceStatusResponse,
  type CommerceStoreResponse,
  type CommerceSyncResponse,
  type CommerceVariantResponse,
  type CommerceVariantsResponse,
  type ConnectPoscake,
  type ConnectShopify,
  type ListOrders,
  type ListVariants,
  type SetPrice,
  type SetStock,
  type SkuCompareResponse,
  type UpdateStore,
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
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { CommerceService } from './commerce.service';

const ctxOf = (user: AuthUser, tenant: TenantContext, req: Request): Ctx => ({
  tenantId: tenant.id,
  userId: user.id,
  ip: clientIp(req),
});

const reportQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/**
 * Shopify and POSCake (spec Part 18, M22 and M26). Reading needs commerce.read; connecting,
 * disconnecting, turning stores on or off and reading now need commerce.manage; changing a price
 * or a stock level on Shopify needs commerce.write.
 */
@Controller('commerce')
@UseGuards(AuthGuard, TenantGuard)
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  @Get()
  @RequirePermission('commerce.read')
  status(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<CommerceStatusResponse> {
    return this.commerce.status(ctxOf(user, tenant, req));
  }

  @Post('stores/shopify')
  @RequirePermission('commerce.manage')
  connectShopify(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(connectShopifySchema)) body: ConnectShopify,
  ): Promise<CommerceStoreResponse> {
    return this.commerce.connectShopify(ctxOf(user, tenant, req), body);
  }

  @Post('stores/poscake')
  @RequirePermission('commerce.manage')
  connectPoscake(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Body(new ZodPipe(connectPoscakeSchema)) body: ConnectPoscake,
  ): Promise<CommerceStoreResponse> {
    return this.commerce.connectPoscake(ctxOf(user, tenant, req), body);
  }

  @Patch('stores/:id')
  @RequirePermission('commerce.manage')
  setStore(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateStoreSchema)) body: UpdateStore,
  ): Promise<CommerceStoreResponse> {
    return this.commerce.setStore(ctxOf(user, tenant, req), id, body);
  }

  @Delete('stores/:id')
  @HttpCode(204)
  @RequirePermission('commerce.manage')
  async disconnect(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.commerce.disconnect(ctxOf(user, tenant, req), id);
  }

  @Post('stores/:id/sync')
  @HttpCode(200)
  @RequirePermission('commerce.manage')
  syncStore(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CommerceSyncResponse> {
    return this.commerce.sync(ctxOf(user, tenant, req), id);
  }

  @Post('sync')
  @HttpCode(200)
  @RequirePermission('commerce.manage')
  syncAll(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<CommerceSyncResponse> {
    return this.commerce.sync(ctxOf(user, tenant, req));
  }

  @Get('variants')
  @RequirePermission('commerce.read')
  variants(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listVariantsSchema)) query: ListVariants,
  ): Promise<CommerceVariantsResponse> {
    return this.commerce.variants(ctxOf(user, tenant, req), query);
  }

  @Put('variants/:id/price')
  @RequirePermission('commerce.write')
  setPrice(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setPriceSchema)) body: SetPrice,
  ): Promise<CommerceVariantResponse> {
    return this.commerce.setPrice(ctxOf(user, tenant, req), id, body);
  }

  @Put('variants/:id/stock')
  @RequirePermission('commerce.write')
  setStock(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setStockSchema)) body: SetStock,
  ): Promise<CommerceVariantResponse> {
    return this.commerce.setStock(ctxOf(user, tenant, req), id, body);
  }

  @Get('skus')
  @RequirePermission('commerce.read')
  skus(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<SkuCompareResponse[]> {
    return this.commerce.skus(ctxOf(user, tenant, req));
  }

  @Get('orders')
  @RequirePermission('commerce.read')
  orders(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(listOrdersSchema)) query: ListOrders,
  ): Promise<CommerceOrdersResponse> {
    return this.commerce.orders(ctxOf(user, tenant, req), query);
  }

  @Get('report')
  @RequirePermission('commerce.read')
  report(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
    @Query(new ZodPipe(reportQuery)) query: z.infer<typeof reportQuery>,
  ): Promise<CommerceReportResponse> {
    return this.commerce.report(ctxOf(user, tenant, req), query.days);
  }

  @Get('changes')
  @RequirePermission('commerce.read')
  changes(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<CommerceChangeResponse[]> {
    return this.commerce.changes(ctxOf(user, tenant, req));
  }

  @Get('calls')
  @RequirePermission('commerce.read')
  calls(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Req() req: Request,
  ): Promise<ApiCallResponse[]> {
    return this.commerce.calls(ctxOf(user, tenant, req));
  }
}
