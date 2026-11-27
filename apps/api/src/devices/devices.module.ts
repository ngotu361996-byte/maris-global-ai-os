import { Module } from '@nestjs/common';
import {
  DeviceAgentController,
  DevicesController,
  WorkerJobsController,
} from './devices.controller';
import { WorkerJobsService } from './worker-jobs.service';
import { DevicesService } from './devices.service';

/** Phase 5: devices and workers (spec Part 26). */
@Module({
  controllers: [DevicesController, WorkerJobsController, DeviceAgentController],
  providers: [DevicesService, WorkerJobsService],
  exports: [DevicesService, WorkerJobsService],
})
export class DevicesModule {}
