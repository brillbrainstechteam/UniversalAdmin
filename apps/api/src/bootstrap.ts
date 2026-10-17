import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { absolutePath as swaggerUiPath } from 'swagger-ui-dist';
import express from 'express';
import { AppModule } from './app.module';
import type { AppConfig } from './config/config';
import { correlationMiddleware } from './common/correlation.middleware';
import { ErrorFilter } from './common/error.filter';
import { createLogger } from './common/logger';

/** Builds the HTTP application. Shared by main.ts and integration tests so both exercise identical middleware. */
export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const logger = createLogger(config.LOG_LEVEL);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
    logger: config.LOG_LEVEL === 'silent' ? false : ['error', 'warn'],
    bodyParser: false,
  });
  // Next.js admin apps proxy /api/* to us; trust only the loopback proxy for client IPs.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(correlationMiddleware(logger));
  app.use((_req: unknown, res: express.Response, next: express.NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/docs/assets', express.static(swaggerUiPath(), { index: false }));
  app.useGlobalFilters(new ErrorFilter(logger));
  app.enableShutdownHooks();
  return app;
}
