import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { API_ROUTES, buildOpenApiDocument } from '@uc/contracts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { testConfig, startApp } from '../helpers';

/** Every route the Nest app actually serves, derived from controller metadata. */
function servedRoutes(): string[] {
  const controllers = AppModule.register(testConfig()).controllers ?? [];
  const routes: string[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (method === undefined || path === undefined) continue;
      const full = `/${[base, path].filter((p) => p && p !== '/').join('/')}`
        .replace(/\/+/g, '/')
        .replace(/:(\w+)/g, '{$1}');
      routes.push(`${RequestMethod[method].toLowerCase()} ${full}`);
    }
  }
  return routes.sort();
}

let app: INestApplication;
beforeAll(async () => {
  app = await startApp();
});
afterAll(() => app.close());

describe('OpenAPI baseline (F-11)', () => {
  it('documents exactly the routes the API serves (excluding docs assets)', () => {
    const served = servedRoutes().filter((r) => !r.includes('/docs') && !r.endsWith('/v1/openapi.json'));
    const documented = API_ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(served).toEqual(documented);
  });

  it('serves the generated document and Swagger UI', async () => {
    const spec = await request(app.getHttpServer()).get('/v1/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths)).toContain('/v1/platform/tenants/{id}/entitlements');
    const docs = await request(app.getHttpServer()).get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('swagger-ui-bundle.js');
    expect((await request(app.getHttpServer()).get('/docs/assets/swagger-ui-bundle.js')).status).toBe(200);
  });

  it('committed docs/api/openapi.json matches the contract (run `pnpm openapi:generate` after API changes)', () => {
    const committed = JSON.parse(
      readFileSync(resolve(__dirname, '../../../../docs/api/openapi.json'), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });
});

describe('health', () => {
  it('liveness and readiness report dependencies', async () => {
    expect((await request(app.getHttpServer()).get('/health/live')).status).toBe(200);
    const ready = await request(app.getHttpServer()).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toMatchObject({ database: { status: 'ok' }, redis: { status: 'ok' } });
  });
});
