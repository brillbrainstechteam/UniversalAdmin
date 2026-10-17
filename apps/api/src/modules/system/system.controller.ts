import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { buildOpenApiDocument, type HealthResponse } from '@uc/contracts';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/config';
import { DbService } from '../../db/db.service';
import { RedisService } from '../../db/redis.service';

async function check(fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await fn();
    return { status: 'ok' as const, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: 'down' as const,
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    };
  }
}

@Controller()
export class SystemController {
  private openapi?: object;

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('health/live')
  live(): HealthResponse {
    return { status: 'ok', checks: {}, time: new Date().toISOString() };
  }

  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const checks = {
      database: await check(() => this.db.ping()),
      redis: await check(() => this.redis.ping()),
    };
    const ok = Object.values(checks).every((c) => c.status === 'ok');
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks, time: new Date().toISOString() };
  }

  @Get('v1/openapi.json')
  openapiJson(): object {
    this.openapi ??= buildOpenApiDocument(this.config.API_PUBLIC_URL);
    return this.openapi;
  }

  @Get('docs')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  )
  docs(): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Universal Commerce OS API</title>
<link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head><body><div id="ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script><script src="/docs/assets/init.js"></script></body></html>`;
  }

  @Get('docs/assets/init.js')
  @Header('Content-Type', 'application/javascript')
  docsInit(): string {
    return `window.ui = SwaggerUIBundle({ url: '/v1/openapi.json', dom_id: '#ui' });`;
  }
}
