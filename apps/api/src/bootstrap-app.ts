import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/errors.filter';
import type { AppConfig } from './config';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), {
    logger: ['error', 'warn', 'log'],
    // Meta signs its webhook over the exact bytes it sent (spec Part 26, signature verification).
    rawBody: true,
  });
  app.use(helmet());
  app.enableCors({
    origin: config.WEB_ORIGIN,
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id', 'X-MARIS-Session', 'X-MARIS-CSRF', 'X-File-Name'],
  });
  // Behind a reverse proxy set TRUST_PROXY so req.ip (used for rate limits and audit) is the client's.
  if (process.env.TRUST_PROXY) app.getHttpAdapter().getInstance().set('trust proxy', process.env.TRUST_PROXY);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();
  return app;
}
