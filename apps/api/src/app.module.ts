import { DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { RolesController } from './roles/roles.controller';
import { TenancyModule } from './tenancy/tenancy.module';
import { TenantsController } from './tenants/tenants.controller';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DbModule, AuditModule, AuthModule, TenancyModule],
      controllers: [HealthController, TenantsController, RolesController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
