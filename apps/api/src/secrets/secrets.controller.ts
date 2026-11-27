import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { createSecretSchema, type CreateSecret, type SecretResponse } from '@maris/contracts';
import { AuthGuard } from '../auth/auth.guard';
import { AuditService } from '../audit/audit.service';
import { clientIp, CurrentTenant, CurrentUser, type AuthUser, type TenantContext } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';
import { OutboxService } from '../outbox/outbox.service';
import { RequirePermission, TenantGuard } from '../tenancy/tenant.guard';
import { SecretVaultService } from './secret-vault.service';

@Controller('secrets')
@UseGuards(AuthGuard, TenantGuard)
export class SecretsController {
  constructor(
    private readonly db: DbService,
    private readonly vault: SecretVaultService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  @Get()
  @RequirePermission('secrets.read')
  list(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantContext): Promise<SecretResponse[]> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, (tx) => this.vault.list(tx, tenant.id));
  }

  @Post()
  @RequirePermission('secrets.manage')
  create(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Body(new ZodPipe(createSecretSchema)) body: CreateSecret,
    @Req() req: Request,
  ): Promise<SecretResponse> {
    return this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const created = await this.vault.create(tx, tenant.id, user.id, body.name, body.value);
      // The value never enters the audit log or the event payload.
      await this.audit.append(tx, {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'secret.created',
        targetType: 'secret',
        targetId: created.id,
        metadata: { name: created.name },
        ip: clientIp(req),
      });
      await this.outbox.enqueue(tx, {
        tenantId: tenant.id,
        type: 'security.secret.created',
        payload: { secretId: created.id, name: created.name },
      });
      return created;
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('secrets.manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.db.withContext({ userId: user.id, tenantId: tenant.id }, async (tx) => {
      const { name } = await this.vault.remove(tx, tenant.id, id);
      await this.audit.append(tx, {
        tenantId: tenant.id,
        actorUserId: user.id,
        action: 'secret.deleted',
        targetType: 'secret',
        targetId: id,
        metadata: { name },
        ip: clientIp(req),
      });
      await this.outbox.enqueue(tx, { tenantId: tenant.id, type: 'security.secret.deleted', payload: { secretId: id, name } });
    });
  }
}
