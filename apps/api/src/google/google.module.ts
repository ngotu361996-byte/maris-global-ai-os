import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module';
import { GoogleApiService } from './google-api.service';
import { GoogleController } from './google.controller';
import { GoogleService } from './google.service';
import { YoutubePublishService } from './youtube-publish.service';

/** Phase 8 (Sprint 26): Google Center (spec Part 16) with the gateway and quota for Google APIs,
 * and the YouTube Center (Part 17): channels and uploads of approved videos and Shorts. */
@Module({
  imports: [SecretsModule],
  controllers: [GoogleController],
  providers: [GoogleApiService, GoogleService, YoutubePublishService],
  exports: [GoogleApiService, GoogleService, YoutubePublishService],
})
export class GoogleModule {}
