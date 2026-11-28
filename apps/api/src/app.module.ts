import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from './config';
import { AiModule } from './ai/ai.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { RolesController } from './roles/roles.controller';
import { TenancyModule } from './tenancy/tenancy.module';
import { TenantsController } from './tenants/tenants.controller';
import { MembersModule } from './members/members.module';
import { OutboxModule } from './outbox/outbox.module';
import { RateLimitGuard } from './ratelimit/rate-limit.guard';
import { RedisModule } from './redis/redis.module';
import { SecretsModule } from './secrets/secrets.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { PluginsModule } from './plugins/plugins.module';
import { DevicesModule } from './devices/devices.module';
import { ContentModule } from './content/content.module';
import { MetaModule } from './meta/meta.module';
import { CrmModule } from './crm/crm.module';
import { GoogleModule } from './google/google.module';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DbModule, RedisModule, AuditModule, OutboxModule, AuthModule, TenancyModule, MembersModule, SecretsModule, AiModule, ConnectorsModule, WorkflowsModule, PluginsModule, DevicesModule, ContentModule, MetaModule, CrmModule, GoogleModule],
      controllers: [HealthController, TenantsController, RolesController],
      providers: [{ provide: APP_CONFIG, useValue: config }, { provide: APP_GUARD, useClass: RateLimitGuard }],
      exports: [APP_CONFIG],
    };
  }
}
