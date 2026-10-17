# Development runbook

## Prerequisites
Node 22+, pnpm 9, Docker Desktop. Google Chrome (E2E uses the installed Chrome; CI downloads Chromium).

## First run
```bash
cp .env.example .env          # local placeholders only — never real secrets
pnpm install
pnpm infra:up                 # Postgres :5440, Redis :6390 (object storage: add --profile storage, Phase 02)
pnpm build                    # builds packages and apps
pnpm db:reset                 # drop + migrate + seed demo data into uc_dev (non-production only)
```

Run the stack (separate terminals):
```bash
pnpm dev:api        # http://localhost:4100  (Swagger UI /docs, spec /v1/openapi.json, /health/ready)
pnpm dev:worker     # outbox relay → BullMQ + domain-event consumers
pnpm dev:merchant   # http://localhost:3100
pnpm dev:platform   # http://localhost:3101
```

## Demo accounts (seeded, `is_demo`, password = `SEED_DEMO_PASSWORD`, default `DemoPass!2026`)
| Email | App | Access |
|---|---|---|
| platform@uc.local | platform admin | platform owner |
| support@uc.local | platform admin | platform support (read-only) |
| owner@aurum.demo | merchant admin | Aurum Wholesale (B2B jewellery) — owner |
| viewer@aurum.demo | merchant admin | Aurum — viewer (read-only; demonstrates permission denial) |
| stock@aurum.demo | merchant admin | Aurum — inventory operator scoped to Mumbai branch |
| owner@lumiere.demo | merchant admin | Lumière Fine (B2C jewellery) — owner |
| owner@northwind.demo | merchant admin | Northwind General (general commerce, no jewellery) — owner |
| multi@demo.local | merchant admin | Aurum catalog editor + Northwind admin (tenant picker) |

Storefront resolver demo: `curl -H "Host: lumiere.localhost" http://localhost:4100/v1/storefront/config`
(`pending-aurum.localhost` is seeded unverified and must return 404).

## Quality gates (same as CI)
```bash
pnpm format:check && pnpm lint && pnpm typecheck
pnpm test          # unit + migration + integration (resets the uc_test database)
pnpm test:e2e      # Playwright; requires `pnpm build`; starts API + both admins itself
pnpm openapi:generate   # regenerate docs/api/openapi.json after API contract changes
```
Tests never touch `uc_dev`. Redis logical DBs: 0 dev, 1 API tests, 2 worker tests, 3 E2E.

## Database
- Migrations: `packages/db/migrations` (forward-only; rollback notes in `ROLLBACK.md`). Generate with
  `pnpm --filter @uc/db generate` after editing `packages/db/src/schema.ts`; the drift test fails if you forget.
- Runtime role `uc_app` is subject to RLS; migrations run as `uc_owner`. Tenant data access must go through
  `DbService.tenant()`; `DbService.system()` is reserved for platform/auth/resolver/worker paths.

## Ports
5440 Postgres · 6390 Redis · 9010 object store (profile) · 4100 API · 3100 merchant admin · 3101 platform admin.
