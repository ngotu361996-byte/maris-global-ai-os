import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { RedisService } from '../redis/redis.module';

export interface RateLimitRule {
  name: string;
  limit: number;
  windowSec: number;
  /** 'ip' counts per client IP; 'ip+email' also keeps a separate counter per e-mail in the body. */
  by: 'ip' | 'ip+email';
}

const RULE_KEY = 'maris:rate-limit';
export const RateLimit = (rule: RateLimitRule) => SetMetadata(RULE_KEY, rule);

/** Applies to every route; routes without @RateLimit get the general API limit. */
export const DEFAULT_RULE: RateLimitRule = { name: 'api', limit: 600, windowSec: 60, by: 'ip' };

/** Fixed-window counters in Redis, so limits hold across API instances. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly redis: RedisService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const rule =
      this.reflector.getAllAndOverride<RateLimitRule | undefined>(RULE_KEY, [context.getHandler(), context.getClass()]) ??
      DEFAULT_RULE;
    const keys = [`rl:${rule.name}:ip:${req.ip ?? 'unknown'}`];
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : null;
    if (rule.by === 'ip+email' && email) {
      keys.push(`rl:${rule.name}:email:${createHash('sha256').update(email).digest('hex').slice(0, 32)}`);
    }
    const window = Math.floor(Date.now() / 1000 / rule.windowSec);
    let retryAfter = 0;
    for (const base of keys) {
      const key = `${base}:${window}`;
      const [[, count]] = (await this.redis.client.multi().incr(key).expire(key, rule.windowSec + 1).exec()) as [
        [Error | null, number],
        unknown,
      ];
      if (count > rule.limit) retryAfter = rule.windowSec - (Math.floor(Date.now() / 1000) % rule.windowSec);
    }
    if (retryAfter > 0) {
      context.switchToHttp().getResponse().setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        { code: 'RATE_LIMITED', message: `Quá nhiều yêu cầu, thử lại sau ${retryAfter} giây` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
