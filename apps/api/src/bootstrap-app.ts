import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/errors.filter';
import type { AppConfig } from './config';

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), { logger: ['error', 'warn', 'log'] });
  app.use(helmet());
  app.enableCors({ origin: config.WEB_ORIGIN, allowedHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id'] });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();
  return app;
}
