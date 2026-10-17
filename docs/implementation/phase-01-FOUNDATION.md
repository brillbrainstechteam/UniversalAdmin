# Phase 01 — FOUNDATION: task plan

## Repo inspection summary (start of phase)
- `F:\Universal Admin` was empty. Build pack copied into the root as instructed by the pack README. `git init` performed (no commits).
- Host: Node 22.18, pnpm 9.15, Docker 28 (Compose v2), Chrome installed (Playwright uses it; no browser download).
- Port conflicts with other local projects (5432–5436, 6379) → this stack uses Postgres **5440**, Redis **6390**, MinIO **9010/9011**, API **4100**, merchant admin **3100**, platform admin **3101**.
- Risks: Windows path contains a space (`Universal Admin`) — all scripts quote paths; decorator metadata under Vitest needs SWC; RLS requires non-owner runtime role.

## Scope
Monorepo + dev infra + CI; tenant / store / channel / location; secure identity; membership + RBAC; platform & merchant admin shells; shared theme components; feature presets + entitlements; tenant resolver (admin + storefront); audit + outbox + idempotency primitives; seed (2 isolated jewellery merchants + 1 general tenant); OpenAPI baseline; migration tests; demo of logins & authorization failures.

Not in scope (later phases): catalog, inventory, pricing, storefront apps (ADR-009), domain verification UI (ADR-011), MFA (ADR-003), impersonation (Phase 12), email delivery (ADR-010).

## Tasks
| # | Task | Output |
|---|---|---|
| T1 | Workspace + tooling | pnpm workspace, tsconfig base, ESLint/Prettier, `.env.example`, `.github/workflows/ci.yml` |
| T2 | Dev infra | `infra/docker-compose.yml` (Postgres 16, Redis 7, MinIO), `infra/postgres/init.sql` (roles `uc_owner`, `uc_app`) |
| T3 | `@uc/contracts` | zod DTOs, permission catalog, presets/features, module registry (nav), error codes, event envelope, OpenAPI registry/generator |
| T4 | `@uc/db` | Drizzle schema, migrations (tables + RLS/grants/append-only trigger), migrator, DB context (`tenantTx`, `systemTx`), audit/outbox writers, seed |
| T5 | API foundation | NestJS app, config validation, correlation id, error filter, zod pipe, auth guards (session audience, tenant membership, permission), CSRF guard, idempotency, health, OpenAPI endpoint + docs |
| T6 | API modules | auth/identity, platform tenants & entitlements, admin context/home/settings/stores/channels/locations/members/invitations/roles/audit, storefront config resolver |
| T7 | Worker | outbox relay → BullMQ (`domain-events`), retry/backoff/dead, idempotent consumer helper |
| T8 | `@uc/ui` | theme tokens (CSS variables), Button, Input/Select/Field, Card, Badge, DataTable w/ pagination, Empty/Error/Loading/Forbidden states, ConfirmDialog, AppShell + Nav, Toast |
| T9 | merchant-admin | login, tenant picker, shell w/ gated nav, Home, Settings: General, Stores & channels, Locations, Staff (members + invitations), Roles, Audit log; invitation accept |
| T10 | platform-admin | login, tenants list (search/filter/sort/paginate), provision tenant, tenant detail (profile, suspend/reactivate, entitlements), platform audit |
| T11 | Seed | platform owner/support; Aurum (b2b_jewellery), Lumière (b2c_jewellery), Northwind (general_commerce); staff with different roles incl. location-scoped and multi-tenant user; verified `*.localhost` domains; all flagged `is_demo` |
| T12 | Tests | unit, integration (real Postgres/Redis), migration, OpenAPI coverage, Playwright e2e |
| T13 | Docs | DEVELOPMENT.md runbook, API permission matrix, ROLLBACK notes, PROGRESS update |

## Screen / action inventory
Legend — States: L loading, E error, Ø empty, D permission denied.

### Merchant admin (`apps/merchant-admin`, :3100)
| Route | User | Precondition | Backend | Permission | States | Test |
|---|---|---|---|---|---|---|
| `/login` | any staff | none | `POST /v1/auth/login {email,password,audience:'merchant'}` → `sessions` | none (throttled, lockout) | L, E (invalid creds / locked / suspended) | int: auth.spec; e2e: login |
| `/accept-invite?token=` | invitee | valid unexpired token | `POST /v1/auth/invitations/preview`, `POST /v1/auth/invitations/accept` → users, memberships | token | L, E (expired/revoked/used) | int: invitations.spec |
| `/` (tenant picker) | staff w/ ≥1 membership | session | `GET /v1/auth/me` | session | L, E, Ø (no memberships) | e2e |
| `/t/[tenantId]` Home | member | active membership + tenant | `GET /v1/admin/context`, `GET /v1/admin/home` (real counts, setup checklist, recent audit) | any active member | L, E, D | int: context.spec; e2e |
| `/t/[tenantId]/settings/general` | owner/admin | — | `GET/PATCH /v1/admin/settings/general` (version) → tenants | `settings.read` / `settings.manage` | L, E, D, version conflict, unsaved warning | int: settings.spec |
| `/t/[tenantId]/settings/stores` (+ channels) | owner/admin | — | `GET/POST/PATCH /v1/admin/stores`, `/v1/admin/channels` | `stores.read` / `stores.manage` | L, E, Ø, D | int: stores.spec |
| `/t/[tenantId]/settings/locations` | owner/admin/inventory op | — | `GET/POST/PATCH /v1/admin/locations` (scope-filtered) | `locations.read` / `locations.manage` | L, E, Ø, D | int: locations.spec (scope) |
| `/t/[tenantId]/settings/staff` | owner/admin | — | `GET /v1/admin/members`, `PATCH /v1/admin/members/:id`, `GET/POST /v1/admin/invitations`, `POST /v1/admin/invitations/:id/revoke` | `staff.read` / `staff.manage` | L, E, Ø, D, last-owner guard | int: staff.spec |
| `/t/[tenantId]/settings/roles` | owner/admin | — | `GET /v1/admin/roles`, `GET /v1/admin/permissions`, `POST/PATCH /v1/admin/roles` | `roles.read` / `roles.manage` | L, E, D, system role read-only | int: roles.spec |
| `/t/[tenantId]/audit` | owner/admin/accountant | — | `GET /v1/admin/audit-events` (cursor, filters) | `audit.read` | L, E, Ø, D | int: audit.spec |

### Platform admin (`apps/platform-admin`, :3101)
| Route | User | Precondition | Backend | Permission | States | Test |
|---|---|---|---|---|---|---|
| `/login` | platform operator | platform_admins row | `POST /v1/auth/login {audience:'platform'}` | platform role | L, E | int: auth.spec |
| `/tenants` | owner/support | — | `GET /v1/platform/tenants?q&status&preset&sort&cursor&limit` | `platform.tenants.read` | L, E, Ø | int: platform-tenants.spec |
| `/tenants/new` | platform owner | — | `POST /v1/platform/tenants` (Idempotency-Key) → tenant, entitlements, store, channel(s), location, system roles, owner invitation, audit, outbox `TenantProvisioned` | `platform.tenants.manage` | L, E (slug taken, validation), D | int + e2e |
| `/tenants/[id]` | owner/support | — | `GET/PATCH /v1/platform/tenants/:id`, `POST …/suspend`, `POST …/reactivate` (reason), `GET/PUT …/entitlements` | read / manage / `platform.entitlements.manage` | L, E, D, confirm dialog | int |
| `/audit` | owner/support | — | `GET /v1/platform/audit-events` | `platform.audit.read` | L, E, Ø | int |

### Storefront API
| Endpoint | Caller | Behavior | Test |
|---|---|---|---|
| `GET /v1/storefront/config` | storefront app / browser | resolve verified domain → active channel + active tenant → brand/theme/currency/locale; unknown/unverified/suspended → 404 `STOREFRONT_NOT_FOUND` | int: storefront.spec |

## State transitions (Phase 01)
- Tenant: `active ⇄ suspended` (reason required, audited, outbox `TenantSuspended`/`TenantReactivated`). `provisioning` is set only inside the provisioning transaction.
- Membership: `invited → active → suspended → active`; the last active owner cannot be suspended or lose the owner role.
- Invitation: `pending → accepted | revoked | expired`.
- Session: `active → revoked | expired`.
- Outbox event: `pending → published | (retry) → dead`.

## Acceptance cases for this phase (mapped to qa/ACCEPTANCE-TESTS.md cross-cutting P0)
| ID | Case | Test file |
|---|---|---|
| F-01 | Tenant A user cannot read/write Tenant B via `X-Tenant-Id`, guessed IDs, or list endpoints | `apps/api/test/integration/tenant-isolation.spec.ts` |
| F-02 | RLS returns zero foreign rows even when a query omits the tenant filter | `packages/db/test/rls.spec.ts` |
| F-03 | Permission denied server-side (viewer PATCH settings, scoped operator outside scope, merchant session on platform API) | `authorization.spec.ts` |
| F-04 | Sensitive actions create audit events; audit rows cannot be updated/deleted | `audit.spec.ts`, `rls.spec.ts` |
| F-05 | Login success/failure, lockout, logout revokes session, suspended tenant denied | `auth.spec.ts` |
| F-06 | Optimistic locking returns 409 on stale version | `settings.spec.ts` |
| F-07 | Tenant provisioning idempotent (replay / reuse / conflict) and emits outbox event in same tx | `platform-tenants.spec.ts`, `outbox.spec.ts` |
| F-08 | Outbox relay publishes at-least-once, retries, dead-letters; consumer dedupes | `apps/worker/test/relay.spec.ts` |
| F-09 | Storefront resolver: verified domain resolves; unverified/unknown/suspended do not | `storefront.spec.ts` |
| F-10 | Migrations apply deterministically on clean DB; no schema drift | `packages/db/test/migrations.spec.ts` |
| F-11 | Every API route documented in OpenAPI | `openapi.spec.ts` |
| F-12 | General-commerce tenant has no jewellery features; nav gated by entitlements + permissions | unit `nav.spec.ts` + e2e |
| F-13 | E2E: merchant login → gated nav → settings edit persists; viewer sees access denied; platform provisions tenant | `e2e/*.spec.ts` |

---

## Results (2026-10-17) — status: implemented, awaiting review

### Commands and outcomes (final run, after dependency upgrades)
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | all files formatted |
| `pnpm lint` | 0 | 123 files, 0 errors, 0 warnings |
| `pnpm typecheck` | 0 | 8 workspace packages |
| `pnpm build` | 0 | contracts, db, api, worker, merchant-admin (12 routes), platform-admin (7 routes) |
| `pnpm test` | 0 | **144 tests**: contracts 19, db 25, ui 2, api 93 (8 files), worker 5 |
| `pnpm test:e2e` | 0 | **9 Playwright tests** against production builds (Chrome) |
| `pnpm audit --audit-level high` | 0 | 0 high/critical (3 moderate remain, ADR-013) |

### Acceptance coverage
| ID | Status | Evidence |
|---|---|---|
| F-01 tenant isolation | PASS | `tenant-isolation.spec.ts` (16 tests: header, guessed IDs GET/PATCH, foreign roles/locations, lists) |
| F-02 RLS | PASS | `packages/db/test/rls.spec.ts` (fail-closed, filter-less query, WITH CHECK, tx-local context) |
| F-03 server-side permission denial | PASS | `authorization.spec.ts`, e2e viewer/support tests |
| F-04 audit + append-only | PASS | `rls.spec.ts` (role + trigger), audit assertions across suites |
| F-05 login/lockout/logout/suspension | PASS | `auth.spec.ts` (16 tests) |
| F-06 optimistic locking | PASS | `admin-resources.spec.ts`, `staff.spec.ts`, `platform.spec.ts` |
| F-07 idempotent provisioning + outbox in tx | PASS | `platform.spec.ts`, `staff.spec.ts`, `outbox.spec.ts` |
| F-08 relay retry/DLQ/dedupe | PASS | `outbox.spec.ts`, `apps/worker/test/relay.spec.ts` (real Redis/BullMQ) |
| F-09 storefront resolver | PASS | `platform.spec.ts` (verified/unverified/unknown/inactive/suspended, gateway key) |
| F-10 migrations from clean DB, no drift | PASS | `migrations.spec.ts` |
| F-11 OpenAPI route coverage | PASS | `openapi.spec.ts` (served routes == documented; committed spec current) |
| F-12 presets / gated nav, general w/o jewellery | PASS | `contracts.spec.ts`, `admin-resources.spec.ts`, e2e |
| F-13 E2E flows | PASS | `e2e/tests/*.spec.ts`; screenshots in `e2e/screenshots/` |

### Defects found and fixed during verification
1. Valid IANA aliases (e.g. `Asia/Kolkata`) rejected by timezone validation → switched to `Intl.DateTimeFormat` probe.
2. Login rate limiter failed open while Redis was connecting (`enableOfflineQueue:false`) → offline queue enabled.
3. Tenant member counts always 0 on platform screens (unqualified correlated subquery, ADR-014) → fixed + regression test.
4. Timestamps truncated in keyset cursors (µs vs ms) → all timestamps `timestamptz(3)`.
5. Composite FKs created before their unique targets → inline UNIQUE constraints.

### Known gaps / blocked items (explicit, not hidden)
- MFA for platform operators: deferred to Phase 11 (ADR-003). Impersonation: Phase 12.
- No email/notification provider: invitation links are shown once to the inviter (ADR-010).
- Domain add/verify UI and storefront apps: Phases 10 / 08–09 (ADR-009, ADR-011). Resolver API is live.
- Object storage container is opt-in and unused until Phase 02 (ADR-012).
- Worked example payloads per endpoint not yet authored (schemas are complete).
- Saved views (spec 03) not built for Phase 01 lists; scheduled with Phase 02 product list.
- CI workflow written but **not executed** (no remote/GitHub run was performed); all its steps were run locally.
- Nothing committed or pushed (repository initialised with `git init` only).
