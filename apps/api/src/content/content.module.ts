import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { DevicesModule } from '../devices/devices.module';
import { ContentAiService } from './content-ai.service';
import { ContentMediaService } from './content-media.service';
import { ContentAgentController, ContentController } from './content.controller';
import { ContentService } from './content.service';

/** Phase 6: content libraries (spec Part 11), AI content writing and image processing (Part 13). */
@Module({
  imports: [AiModule, DevicesModule],
  controllers: [ContentController, ContentAgentController],
  providers: [ContentService, ContentAiService, ContentMediaService],
  exports: [ContentService],
})
export class ContentModule {}
