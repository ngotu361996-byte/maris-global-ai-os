import { Module } from '@nestjs/common';
import { MetaModule } from '../meta/meta.module';
import { CrmController } from './crm.controller';
import { CrmService } from './crm.service';

/** Phase 7: CRM (spec Part 20, M25) with contacts from Meta Lead Ads and the inbox (Sprint 24). */
@Module({
  imports: [MetaModule],
  controllers: [CrmController],
  providers: [CrmService],
})
export class CrmModule {}
