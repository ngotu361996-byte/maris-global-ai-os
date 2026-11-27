import { Module } from '@nestjs/common';
import { DeviceAgentController, DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

/** Phase 5: devices and workers (spec Part 26). */
@Module({
  controllers: [DevicesController, DeviceAgentController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
