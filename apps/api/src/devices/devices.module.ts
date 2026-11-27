import { Module } from '@nestjs/common';
import {
  DeviceAgentController,
  DevicesController,
  WorkerJobsController,
} from './devices.controller';
import { WorkerJobsService } from './worker-jobs.service';
import { DevicesService } from './devices.service';
import { SystemMonitorController } from './system-monitor.controller';
import { SystemMonitorService } from './system-monitor.service';

/** Phase 5: devices, workers, the code sandbox (spec Part 26) and system monitoring. */
@Module({
  controllers: [
    DevicesController,
    WorkerJobsController,
    DeviceAgentController,
    SystemMonitorController,
  ],
  providers: [DevicesService, WorkerJobsService, SystemMonitorService],
  exports: [DevicesService, WorkerJobsService],
})
export class DevicesModule {}
