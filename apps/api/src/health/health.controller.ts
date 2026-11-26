import { Controller, Get } from '@nestjs/common';
import { DbService } from '../db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  async health() {
    const database = (await this.db.ping()) ? 'up' : 'down';
    return { status: database === 'up' ? 'ok' : 'degraded', database, time: new Date().toISOString() };
  }
}
