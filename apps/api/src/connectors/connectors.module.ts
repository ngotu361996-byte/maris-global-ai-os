import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';

/** Phase 4: Connector Hub (spec Part 24). Workflows use it for connector steps and webhooks. */
@Module({
  imports: [AiModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
