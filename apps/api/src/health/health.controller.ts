import { Controller, Get } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { RedisService } from '../redis/redis.module';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  async health() {
    const [dbUp, redisUp] = await Promise.all([this.db.ping(), this.redis.ping()]);
    const database = dbUp ? 'up' : 'down';
    const redis = redisUp ? 'up' : 'down';
    return { status: dbUp && redisUp ? 'ok' : 'degraded', database, redis, time: new Date().toISOString() };
  }
}
