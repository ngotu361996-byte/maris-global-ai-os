import { Module } from '@nestjs/common';
import { GoogleModule } from '../google/google.module';
import { WebCheckService } from './web-check.service';
import { WebSyncService } from './web-sync.service';
import { WebController } from './web.controller';
import { WebService } from './web.service';

/** Phase 8 (Sprint 29): Website and SEO Center (spec Parts 16 and 18, M21): Google Analytics 4
 * and Search Console read through the Google gateway, and website checks of public pages. */
@Module({
  imports: [GoogleModule],
  controllers: [WebController],
  providers: [WebSyncService, WebCheckService, WebService],
  exports: [WebService],
})
export class WebModule {}
