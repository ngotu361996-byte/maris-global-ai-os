import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { WebhookIntakeController, WebhookIntakeService } from './webhook-intake';
import { WorkflowRunsService } from './workflow-runs.service';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';

/**
 * Phase 4: Workflow Studio (definitions, versions, runs). AI steps run through the AI module's
 * tasks, connector steps through the Connector Hub; webhook connectors start runs from here.
 */
@Module({
  imports: [AiModule, ConnectorsModule],
  controllers: [WorkflowsController, WebhookIntakeController],
  providers: [WorkflowsService, WorkflowRunsService, WebhookIntakeService],
})
export class WorkflowsModule {}
