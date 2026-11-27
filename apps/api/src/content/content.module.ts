import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ContentAiService } from './content-ai.service';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';

/** Phase 6: content libraries (spec Part 11) and AI content writing (Part 13). */
@Module({
  imports: [AiModule],
  controllers: [ContentController],
  providers: [ContentService, ContentAiService],
  exports: [ContentService],
})
export class ContentModule {}
