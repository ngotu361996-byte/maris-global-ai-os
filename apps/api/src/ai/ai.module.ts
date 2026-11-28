import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AiProvidersController } from './ai-providers.controller';
import { AiProvidersService } from './ai-providers.service';
import { AiRouterService } from './ai-router.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';
import { ControlService } from './control.service';
import { CostGovernorService } from './cost-governor.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { CouncilController } from './council.controller';
import { CouncilService } from './council.service';
import { ModelsService } from './models.service';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';

/** Phase 3: AI Provider Gateway, AI Router with failover, AI Chat, AI Agents, project memory,
 * Structured Tasks with approval, Emergency Stop, the Cost Governor, the Model Registry, the AI Council, file uploads
 * AI Central Command (plans from a business goal) and Skills. */
@Module({
  controllers: [AiProvidersController, ChatController, AgentsController, MemoryController, TasksController, CouncilController, FilesController, PlansController, SkillsController],
  providers: [AiProvidersService, AiRouterService, ChatService, CircuitBreakerService, AgentsService, MemoryService, ControlService, CostGovernorService, TasksService, ModelsService, CouncilService, FilesService, PlansService, SkillsService],
  exports: [AiRouterService, AiProvidersService, TasksService, ControlService, SkillsService, CostGovernorService],
})
export class AiModule {}
