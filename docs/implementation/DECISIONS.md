# Architecture Decision Log

Format: context → decision → consequences/trade-offs → rollback. Status: Accepted | Proposed (needs user input) | Superseded.
Safe defaults were chosen where the specs are ambiguous; items marked **Proposed** need your confirmation before the phase that depends on them.

---

## ADR-001 Stack and monorepo tooling — Accepted (Phase 01)
- Context: `specs/01` mandates NestJS modular monolith + workers, Next.js admin/storefronts, TypeScript strict, PostgreSQL, Redis/BullMQ, S3-compatible storage, OpenAPI. Repo was empty.
- Decision: pnpm workspaces (no Turborepo yet), Node 22, TypeScript strict everywhere. NestJS 11 (SWC builder), Next.js 15 App Router + React 19, Drizzle ORM + node-postgres with hand-reviewable SQL migrations, zod 3 shared schemas + `@asteasolutions/zod-to-openapi`, BullMQ 5 + ioredis, Vitest (unit + integration, `unplugin-swc` for decorator metadata), Playwright (uses locally installed Chrome, no browser download), ESLint 9 flat config + Prettier. MinIO for S3-compatible dev storage.
- Why Drizzle over Prisma: SQL-first migrations we can review and extend with RLS/grants/triggers, no binary query engine, explicit transactions where we set RLS context.
- Trade-offs: Drizzle has no down-migrations → rollback is documented per migration (see `packages/db/migrations/ROLLBACK.md`).
- Rollback: swapping ORM is contained in `packages/db` + repositories.

## ADR-002 Multi-tenancy enforcement — Accepted (Phase 01)
- Decision: shared database, shared schema, `tenant_id` on every tenant-owned row, tenant-scoped unique constraints and FKs. Two layers:
  1. Application: every repository query filters by the resolved tenant id.
  2. Database: Row-Level Security on all tenant-owned tables for the runtime role `uc_app` (not table owner). Each request runs in a transaction that sets `app.tenant_id` (`set_config(..., true)` = transaction-local). Platform/system work uses an explicit `app.bypass_rls='on'` context available only through `DbService.systemTx()`.
- Migrations run as `uc_owner`; runtime connects as `uc_app` (DML only; no UPDATE/DELETE on `audit_events`).
- Trade-off: RLS is defence-in-depth against forgotten filters, not against code that deliberately calls `systemTx`; `systemTx` usages are reviewed and limited to platform, auth and worker paths.
- Rollback: disable policies per table (documented); app-level filtering remains.

## ADR-003 Identity, sessions and tenant resolution — Accepted (Phase 01)
- Passwords: argon2id (`@node-rs/argon2`), min length 12, max 128. Account lockout after 5 consecutive failures for 15 minutes, plus per-IP request throttling on login.
- Sessions: opaque random 256-bit tokens; only SHA-256 hash stored; HttpOnly, SameSite=Strict cookies, `Secure` in production. Separate audiences and cookie names for merchant (`uc_m_sess`) and platform (`uc_p_sess`) — a merchant session can never call `/v1/platform/*`. Absolute TTL 12h (merchant) / 8h (platform), idle timeout 2h; logout and "log out all sessions" revoke server-side.
- CSRF: SameSite=Strict + mandatory `X-UC-CSRF: 1` header on cookie-authenticated mutations + Origin allow-list. Admin apps call the API through a same-origin Next.js rewrite (`/api/*`), so no CORS is enabled.
- Merchant tenant resolution: client sends `X-Tenant-Id`; server validates an *active* membership + *active* tenant on every request; otherwise 403 (`TENANT_ACCESS_DENIED` / `TENANT_SUSPENDED`). Resource lookups use tenant-scoped queries so foreign IDs return 404 (no existence leak).
- Storefront resolution: request `Host`, or `X-Storefront-Host` only when accompanied by a valid storefront gateway key (timing-safe compare); domain must be verified and channel/tenant active.
- MFA for privileged operators (`specs/06`) is **deferred to Phase 11** (TOTP + recovery codes). Until then platform admin access is limited to seeded/invited platform operators. Recorded as a known gap.

## ADR-004 Module placement — Accepted (Phase 01)
- `specs/01` lists a top-level `modules/` folder. Decision: domain modules live in `apps/api/src/modules/<name>` (NestJS modules of the monolith); shared persistence (schema, migrations, DB context, outbox/audit writers) lives in `packages/db` so the worker can use it. Dependency rule: modules communicate via exported services or domain events; no module imports another module's internals (enforced by ESLint `no-restricted-imports` patterns as modules grow).
- Trade-off: avoids ~25 workspace packages with their own build steps; extraction to packages later is mechanical.

## ADR-005 RBAC model — Accepted (Phase 01)
- Permission catalog is code-defined (stable string keys in `@uc/contracts`). Tenant roles are rows (system roles seeded per tenant, read-only; custom roles editable). A membership can hold several roles; effective permissions = union. Optional location scope on membership (`location_scope` = null means all locations).
- Platform roles (`platform_owner`, `platform_support`) are separate from tenant roles; platform users have no implicit access to tenant data (impersonation = Phase 12, just-in-time, audited).
- Authorization happens server-side on entity resolution; navigation hiding is cosmetic only.
- Separation of duties (maker-checker) is modelled as distinct permissions (e.g. `rates.edit` vs `rates.approve`) and enforced in the relevant phase.

## ADR-006 Feature presets and entitlements — Accepted (Phase 01)
- Presets: `b2b_jewellery`, `b2c_jewellery`, `hybrid_jewellery`, `general_commerce`. Each maps to a default feature set. Effective entitlements = preset defaults + per-tenant overrides (platform-managed, audited). General commerce has `jewellery` disabled; jewellery fields are never mandatory there.
- Merchant navigation = module registry ∩ implemented modules ∩ entitlements ∩ permissions.

## ADR-007 API conventions — Accepted (Phase 01)
- Errors `{code,message,details,correlationId}`; correlation id from `X-Correlation-Id` (validated) or generated, returned on every response.
- Pagination: cursor (opaque base64url of sort key + id) and `limit` (1–100, default 25), response `{items,nextCursor}`; whitelisted sort fields only.
- Optimistic locking: every mutable row has `version`; PATCH requires `version`; mismatch → 409 `VERSION_CONFLICT`.
- Idempotency: `Idempotency-Key` required on creation endpoints with external effects (Phase 01: tenant provisioning, invitations). Stored per (scope, key) with request hash; same key + same body replays response; same key + different body → 422 `IDEMPOTENCY_KEY_REUSED`; concurrent in-flight → 409 `IDEMPOTENCY_IN_PROGRESS`.
- Decimals/money serialized as strings (`{amountMinor,currency}` for money).

## ADR-008 Audit and outbox — Accepted (Phase 01)
- `audit_events` append-only (runtime role has no UPDATE/DELETE + trigger rejects them). Values redacted by key pattern (password, token, secret, hash, credential, authorization, cookie).
- `outbox_events` uses the contract envelope `{eventId,eventType,eventVersion,tenantId,aggregateType,aggregateId,aggregateVersion,occurredAt,correlationId,causationId,payload}`; inserted in the same transaction as the business change. Worker relay claims with `FOR UPDATE SKIP LOCKED`, publishes to BullMQ queue `domain-events` with `jobId = eventId` (dedupe), exponential backoff, `dead` after max attempts. Consumers record `(consumer,event_id)` in `processed_events` within their transaction.

## ADR-009 Storefront apps timing — Accepted (Phase 01)
- Phase 01 delivers the storefront *resolver* (`GET /v1/storefront/config`) with tests; `apps/storefront-b2b` and `apps/storefront-b2c` are created in Phases 08/09 when they have real catalog/checkout to show, to avoid shell pages without function.

## ADR-010 Invitations without an email provider — Accepted (Phase 01)
- No notification connector exists yet (Phase 11). Invitations generate a single-use token (hash stored, 7-day expiry); the invite link is shown once to the inviting admin to deliver out-of-band. No email is claimed to be sent.

## ADR-011 Domain verification — Accepted (Phase 01)
- Phase 01 seeds verified `*.localhost` demo domains for the resolver. Domain add/verify (DNS TXT) UI and API arrive in Phase 10; no unverified domain resolves.

## ADR-012 S3-compatible dev storage — Accepted (Phase 01)
- Context: MinIO images could not be pulled (Docker Hub repository unavailable, Quay requires auth) on 2026-10-17.
- Decision: SeaweedFS (`chrislusf/seaweedfs`, S3 API) behind the opt-in compose profile `storage`; not started by default because nothing uses object storage until Phase 02. Application code will use the generic S3 API only, so MinIO/AWS S3/R2 remain drop-in.
- Revisit at Phase 02 if a different S3-compatible image is preferred.

## ADR-013 Dependency security overrides — Accepted (Phase 01)
- `pnpm audit` flagged: drizzle-orm < 0.45.2 (SQL identifier escaping, **runtime**), postcss < 8.5.18 via Next.js (build-time), tinypool < 2.1.2 via Vitest (dev-only).
- Decision: drizzle-orm upgraded to ^0.45.2; `pnpm.overrides` pin postcss ≥ 8.5.18 and tinypool ≥ 2.1.2. Full test suite re-run green after the change. CI runs `pnpm audit --audit-level high`.
- Remaining: 3 moderate advisories (not gating). Remove overrides once Next.js/Vitest ship patched transitive versions.

## ADR-014 Deliberate subquery column qualification — Accepted (Phase 01)
- Drizzle renders `${table.column}` unqualified in single-table queries; inside a correlated subquery that silently binds to the inner table (found via E2E screenshot: member counts showed 0). Raw-SQL subqueries must reference outer columns as `"table"."column"`. Regression test added.

---

## Open decisions (Proposed — safe defaults applied, confirm before the dependent phase)

| ID | Topic | Safe default | Needed by |
|---|---|---|---|
| OD-1 | Money representation in DB | `amount_minor BIGINT` + `currency CHAR(3)` for money; `NUMERIC(20,6)` for weights/rates; rounding half-up at defined stages | Phase 06 |
| OD-2 | Decimal library | `decimal.js` (configured precision 40) in pricing engine | Phase 03/06 |
| OD-3 | Inventory authority default | ERP-authoritative when a connector with `stockRead` is configured, otherwise commerce-authoritative; per-connector granularity recorded | Phase 04/05 |
| OD-4 | Checkout rate-lock moment | lock at quote creation with TTL (default 15 min), revalidate at checkout; configurable per channel | Phase 06/07 |
| OD-5 | Invoicing authority | ERP if merchant chooses; otherwise commerce issues "proforma/reference" documents only, never self-labelled tax-compliant | Phase 07/09 |
| OD-6 | Backorder | disabled by default; negative stock only with explicit approved policy | Phase 04 |
| OD-7 | Tax | versioned tax-rule provider with merchant-entered rates flagged "pending accountant validation"; no hardcoded GST rates | Phase 06/07 |
| OD-8 | Metal-rate provider | manual source only until a licensed provider + credentials are supplied | Phase 06 |
| OD-9 | ERP vendor | simulator + CSV/XLSX only until vendor docs + sandbox credentials are supplied | Phase 05 |
| OD-10 | MFA method for platform operators | TOTP + recovery codes | Phase 11 |
