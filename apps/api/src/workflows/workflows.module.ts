import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/** Phase 4: Workflow Studio (definitions, versions, runs). AI steps run through the AI module's tasks. */
@Module({
  imports: [AiModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowRunsService],
})
export class WorkflowsModule {}
