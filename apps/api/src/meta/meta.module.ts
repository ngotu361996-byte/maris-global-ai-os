import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module';
import { MetaGraphService } from './meta-graph.service';
import { MetaPublishService } from './meta-publish.service';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';

/** Phase 7: Meta Control Center (spec Part 14) and the API Governor for Meta (Part 15),
 * publishing to Pages and Instagram (Sprint 22). */
@Module({
  imports: [SecretsModule],
  controllers: [MetaController],
  providers: [MetaService, MetaGraphService, MetaPublishService],
  exports: [MetaService, MetaGraphService, MetaPublishService],
})
export class MetaModule {}
