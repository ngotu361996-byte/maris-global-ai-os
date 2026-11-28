import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module';
import { CommerceApiService } from './commerce-api.service';
import { CommerceSyncService } from './commerce-sync.service';
import { CommerceController } from './commerce.controller';
import { CommerceService } from './commerce.service';

/** Phase 8 (Sprint 28): Shopify and POSCake stores (spec Part 18, M22 and M26), read on a
 * schedule through their own gateway, with price and stock changes on Shopify. */
@Module({
  imports: [SecretsModule],
  controllers: [CommerceController],
  providers: [CommerceApiService, CommerceSyncService, CommerceService],
  exports: [CommerceService],
})
export class CommerceModule {}
