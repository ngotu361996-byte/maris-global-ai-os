import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { SecretsModule } from '../secrets/secrets.module';
import { MetaGraphService } from './meta-graph.service';
import { MetaInboxController, MetaWebhookController } from './meta-inbox.controller';
import { MetaInboxService } from './meta-inbox.service';
import { MetaLeadsService } from './meta-leads.service';
import { MetaPublishService } from './meta-publish.service';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';

/** Phase 7: Meta Control Center (spec Part 14) and the API Governor for Meta (Part 15),
 * publishing to Pages and Instagram (Sprint 22), the inbox and webhook (Sprint 23), Lead Ads (Sprint 24). */
@Module({
  imports: [SecretsModule, AiModule],
  controllers: [MetaController, MetaInboxController, MetaWebhookController],
  providers: [
    MetaService,
    MetaGraphService,
    MetaPublishService,
    MetaInboxService,
    MetaLeadsService,
  ],
  exports: [MetaService, MetaGraphService, MetaPublishService, MetaLeadsService],
})
export class MetaModule {}
