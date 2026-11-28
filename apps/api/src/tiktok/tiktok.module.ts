import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module';
import { TiktokApiService } from './tiktok-api.service';
import { TiktokPublishService } from './tiktok-publish.service';
import { TiktokController } from './tiktok.controller';
import { TiktokService } from './tiktok.service';

/** Phase 8 (Sprint 27): TikTok Center (spec Part 17, M19) with its own gateway for TikTok's APIs:
 * accounts, Direct Post and drafts of approved videos, and the accounts' video figures. */
@Module({
  imports: [SecretsModule],
  controllers: [TiktokController],
  providers: [TiktokApiService, TiktokService, TiktokPublishService],
  exports: [TiktokApiService, TiktokService, TiktokPublishService],
})
export class TiktokModule {}
