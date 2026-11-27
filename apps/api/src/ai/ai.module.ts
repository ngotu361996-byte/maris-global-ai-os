import { Module } from '@nestjs/common';
import { AiProvidersController } from './ai-providers.controller';
import { AiProvidersService } from './ai-providers.service';
import { AiRouterService } from './ai-router.service';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { CircuitBreakerService } from './circuit-breaker.service';

/** Phase 3: AI Provider Gateway, AI Router with failover, AI Chat. */
@Module({
  controllers: [AiProvidersController, ChatController],
  providers: [AiProvidersService, AiRouterService, ChatService, CircuitBreakerService],
  exports: [AiRouterService, AiProvidersService],
})
export class AiModule {}
