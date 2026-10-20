# Staging deployment and CI/CD (Phase 12)

> Status: **design and checklist only — nothing has been deployed.** Hosting, a cloud account, domains and TLS
> certificates are not chosen yet (see `docs/integrations/BLOCKED-DEPENDENCIES.md`). Deploying needs the user's
> explicit go-ahead and credentials.

## What CI does today (`.github/workflows/ci.yml`, every pull request and push to `main`)
1. Postgres 16 and Redis 7 service containers; database roles from `infra/postgres/init.sql`; SeaweedFS for S3.
2. `pnpm install --frozen-lockfile`, `pnpm audit --audit-level high`.
3. Build packages, then `format:check`, `lint`, `typecheck`.
4. OpenAPI drift check: `pnpm openapi:generate && git diff --exit-code docs/api/openapi.json`.
5. `pnpm test` (unit, migration, integration — including the Phase 12 route matrix and RLS sweep).
6. `pnpm build` (all apps), `pnpm db:migrate && pnpm db:seed` from a clean database, then Playwright E2E.

A change that fails any step does not merge.

## Proposed staging pipeline (to implement once hosting is chosen)
| Stage | Trigger | What happens | Gate |
|---|---|---|---|
| Build | merge to `main` | CI above; build one container image per app (`api`, `worker`, `merchant-admin`, `platform-admin`, `buyer-portal`, `storefront`) tagged with the commit SHA | CI green |
| Migrate | manual approval | run `pnpm db:migrate` as `uc_owner` against staging **before** new code starts; migrations are forward-only and additive within a release (see `packages/db/migrations/ROLLBACK.md`) | backup taken within the last hour |
| Deploy | after migrate | roll out `worker` and `api` first, then the four web apps; readiness = `GET /health/ready` (database + Redis) | readiness green for 5 min |
| Smoke | after deploy | `pnpm test:e2e` against staging URLs with a staging-only demo tenant; `psql -f scripts/invariants.sql` | all pass |
| Promote | manual | same image SHAs to production | release checklist (RELEASE.md) |

## Staging environment requirements
- Managed Postgres 16 with point-in-time recovery (RPO 15 min target, `BACKUP-RESTORE.md`); two roles: `uc_owner`
  (migrations only) and `uc_app` (runtime, subject to row-level security). The app must never run as the owner.
- Redis 7 (rate limits, queues, support handoff codes — losing it is an outage of those features, not data loss).
- S3-compatible bucket with versioning for media.
- TLS on every hostname; merchant storefront domains verified by DNS TXT (Phase 10); wildcard certificates or ACME
  per domain (blocked: hosting).
- Secrets from the platform's secret manager, never in images or the repository.

## Environment variables that must differ from development
The API refuses to start with `NODE_ENV=production` when any of these are wrong:

| Variable | Production value |
|---|---|
| `COOKIE_SECURE` | `true` |
| `PAYMENTS_SANDBOX_ENABLED` | `false` (sandbox gateway takes no real money) |
| `SECRETS_ENCRYPTION_KEY` | private random value (webhook secrets, TOTP seeds) |
| `PREVIEW_TOKEN_SECRET` | private random value |
| `WEBHOOKS_ALLOW_PRIVATE_TARGETS` | `false` (SSRF guard) |
| `STOREFRONT_RATE_LIMIT_MULTIPLIER` | `1` |

Also set: `STOREFRONT_GATEWAY_KEY` (private), `ALLOWED_ORIGINS` (admin origins only), `MERCHANT_ADMIN_URL`,
`API_PUBLIC_URL`, S3 credentials. Never run `pnpm db:seed` against staging data you care about or against production:
it creates demo tenants and demo passwords.

## Staging data
Use one staging-only demo tenant created through the platform console (flagged demo). Do not copy production
customer data into staging.
