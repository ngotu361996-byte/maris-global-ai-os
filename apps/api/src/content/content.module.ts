import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { DevicesModule } from '../devices/devices.module';
import { ContentAiService } from './content-ai.service';
import { ContentMediaService } from './content-media.service';
import { ContentAgentController, ContentController } from './content.controller';
import { ContentService } from './content.service';
import { ContentVoiceService } from './content-voice.service';
import { SecretsModule } from '../secrets/secrets.module';

/** Phase 6: content libraries (spec Part 11), AI content writing and image and video processing on
 * Media Workers (Part 13) and AI voice-over (Part 12). */
@Module({
  imports: [AiModule, DevicesModule, SecretsModule],
  controllers: [ContentController, ContentAgentController],
  providers: [ContentService, ContentAiService, ContentMediaService, ContentVoiceService],
  exports: [ContentService],
})
export class ContentModule {}
