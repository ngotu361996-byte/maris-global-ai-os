import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';

/** Phase 4: Plugin Center (spec Part 23). Installs skills, connectors and workflows as one plugin. */
@Module({
  imports: [AiModule, ConnectorsModule, WorkflowsModule],
  controllers: [PluginsController],
  providers: [PluginsService],
})
export class PluginsModule {}
