import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module';
import { MetaGraphService } from './meta-graph.service';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';

/** Phase 7: Meta Control Center (spec Part 14) and the API Governor for Meta (Part 15). */
@Module({
  imports: [SecretsModule],
  controllers: [MetaController],
  providers: [MetaService, MetaGraphService],
  exports: [MetaService, MetaGraphService],
})
export class MetaModule {}
