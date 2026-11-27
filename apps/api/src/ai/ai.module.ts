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

/** Phase 3: AI Provider Gateway, AI Router with failover, AI Chat, AI Agents, project memory,
 * Structured Tasks with approval, Emergency Stop and the Cost Governor. */
@Module({
  controllers: [AiProvidersController, ChatController, AgentsController, MemoryController, TasksController],
  providers: [AiProvidersService, AiRouterService, ChatService, CircuitBreakerService, AgentsService, MemoryService, ControlService, CostGovernorService, TasksService],
  exports: [AiRouterService, AiProvidersService],
})
export class AiModule {}
