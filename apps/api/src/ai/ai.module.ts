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

/** Phase 3: AI Provider Gateway, AI Router with failover, AI Chat, AI Agents and project memory. */
@Module({
  controllers: [AiProvidersController, ChatController, AgentsController, MemoryController],
  providers: [AiProvidersService, AiRouterService, ChatService, CircuitBreakerService, AgentsService, MemoryService],
  exports: [AiRouterService, AiProvidersService],
})
export class AiModule {}
