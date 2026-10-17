# Universal Commerce OS — Master Implementation Plan

Status: planning baseline created 2026-10-17 from the build pack (`CLAUDE.md`, `specs/00–06`, `contracts/API-AND-EVENTS.md`, `qa/ACCEPTANCE-TESTS.md`, `prompts/00–12`).
Repository state at start: empty (greenfield) — no existing stack to preserve.

Each phase is a vertical slice: schema + migration + API (OpenAPI) + worker jobs where relevant + UI + seed + tests + docs.
A phase is only "done" when its P0 acceptance cases pass with real assertions and the user approves the gate.
Cross-references: decisions in [DECISIONS.md](DECISIONS.md), state in [PROGRESS.md](PROGRESS.md).

## 0. Target repository layout

```
apps/
  api/                 NestJS modular monolith (/v1/platform, /v1/admin, /v1/storefront, /v1/integrations, /v1/auth)
    src/modules/<module>/  tenant, identity, access(rbac), store, audit, outbox, catalog, jewellery, inventory, rates,
                           pricing, customer, company, quote, cart, order, payment, tax, fulfillment, marketing,
                           promotions, content, analytics, notifications, integrations, automation
  worker/              BullMQ workers: outbox relay, imports/sync, reservation expiry, rate staleness, exports
  merchant-admin/      Next.js merchant admin (feature-gated navigation)
  platform-admin/      Next.js platform super-admin
  storefront-b2b/      Next.js B2B buyer portal (Phase 08)
  storefront-b2c/      Next.js B2C storefront (Phase 09)
packages/
  contracts/           zod schemas, DTOs, permission catalog, feature presets, error codes, OpenAPI registry, event envelope
  db/                  Drizzle schema, SQL migrations, migrator, seed, DB context (RLS) helpers
  ui/                  shared React components + theme tokens
  config/              shared tsconfig / eslint presets
  connector-sdk/       ERP adapter contract, capability shape, simulator (Phase 05)
infra/                 docker-compose (Postgres, Redis, MinIO), DB bootstrap SQL
docs/                  implementation plans, ADR log, progress, runbooks
```

(Deviation from `specs/01` "top-level `modules/`": see ADR-004.)

## 1. Phase map

| # | Phase | Depends on | Key modules / files | Migrations (main tables) | Main API surface | Permissions introduced | Key QA (from qa/ACCEPTANCE-TESTS) | Demo criteria |
|---|---|---|---|---|---|---|---|---|
| 01 | FOUNDATION | — | monorepo, infra, `packages/{contracts,db,ui,config}`, api modules tenant/identity/access/store/audit/outbox/idempotency, worker outbox relay, merchant-admin + platform-admin shells | users, sessions, platform_admins, tenants, tenant_entitlements, stores, channels, channel_domains, locations, roles, memberships, membership_roles, invitations, audit_events, outbox_events, processed_events, idempotency_keys + RLS/grants | `/v1/auth/*`, `/v1/admin/{context,home,settings,stores,channels,locations,members,invitations,roles,permissions,audit-events}`, `/v1/platform/{tenants,entitlements,presets,audit-events}`, `/v1/storefront/config`, health, OpenAPI | settings.*, stores.*, locations.*, staff.*, roles.*, audit.read; platform.* | Cross-tenant isolation (URL/ID/API), server-side permission denial, audit on sensitive actions, migrations deterministic from clean DB, CI clean | 2 isolated jewellery merchants + 1 general tenant seeded; logins + authorization failures shown; tenant provisioning from platform admin |
| 02 | CATALOG | 01 | catalog module, media (S3/MinIO), storefront read API | products, variants, categories, collections, attribute_defs, media_assets, channel_publications, product_versions | `/v1/admin/products|variants|categories|collections|media`, `/v1/storefront/catalog/*` | catalog.read/edit/publish | General product without jewellery data; tenant isolation; status & variant (SKU) uniqueness; optimistic locking | Searchable paginated product admin, publish to channel, storefront read by domain |
| 03 | JEWELLERY | 02 | jewellery module (spec, components, serialized items) | jewellery_specs, gemstone_components, inventory_items(serial,huid), measurement_raw | `/v1/admin/items`, jewellery spec sub-resources | jewellery.edit, items.edit | gross/net/fine/stone + QTY/PCS persist/render independently; 3 same-design pieces different weights; HUID uniqueness; exact decimal precision | Serial item detail/bulk forms with validation & edit policy |
| 04 | INVENTORY | 03 | inventory module, reservation expiry worker | stock_balances, stock_movements (append-only), reservations, stock_snapshots, stock_conditions | `/v1/admin/inventory/{balances,movements,reservations,adjustments,transfers}` | inventory.read/adjust/transfer | Two concurrent last-item checkouts → ≤1 success; expired reservation released; no double count | ATP dashboard, adjustments with reason, conflict views |
| 05 | CONNECTORS | 04 | connector-sdk, integrations module, CSV/XLSX adapter, deterministic simulator, import jobs, DLQ | connector_definitions, connections(credential_ref), field_mappings(versioned), import_batches/rows, sync_jobs/checkpoints, external_record_map, reconciliation_issues, outbound_commands | `/v1/admin/integrations/*`, `/v1/integrations/*` (signed) | integrations.read/manage/run, reconciliation.resolve | Reimport 1000 records no duplicates; field ownership; out-of-order/unknown/deleted/partial feed; retry same key no duplicate ERP order; polling never advertised as real-time | Initial import, incremental reimport, mismatch resolution, outbound order simulator |
| 06 | PRICING | 03 (04 for stock version) | rates + pricing modules, provider adapter contract + manual source | rate_sources, metal_rates (append-only, maker-checker), price_books, price_rules (versioned DSL), price_quotes | `/v1/admin/rates/*`, `/v1/admin/pricing/*`, `/v1/storefront/pricing-quotes` | rates.edit, rates.approve, pricing.edit, pricing.publish | Gross/net rule fixtures exact; making/stone/discount breakdown no drift; stale policy; quote TTL | Calculator with explainable breakdown; rate approval flow |
| 07 | ORDERS | 04, 06 | cart, quote, order, payment(sandbox) modules, order outbox | carts, cart_lines, quotes, quote_lines, orders, order_lines (immutable price snapshot), order_events, approvals, payments(sandbox) | `/v1/admin/orders|quotes`, `/v1/storefront/carts|checkouts|orders` | orders.*, quotes.*, approvals.approve | Checkout reprice+reserve; immutable snapshot; old order unaffected by new rate; race & expiry e2e | Admin order list/detail/timeline; sandbox payment clearly labelled |
| 08 | B2B | 07 | company module, buyer portal app | companies, company_locations, company_buyers, price_book_assignments, credit_accounts | `/v1/admin/companies/*`, `/v1/storefront/b2b/*` | companies.*, credit.manage; buyer scopes | Restricted buyer cannot access other company/location/price book/invoice; RFQ→quote→order; credit validation; partial fulfil | Buyer portal bulk order, RFQ negotiation |
| 09 | B2C | 07 | storefront-b2c app, customer accounts, payment adapter webhooks (sandbox), fulfillment/returns | customers, addresses, consents, shipments, returns, refunds | `/v1/storefront/*` customer/cart/checkout | fulfillment.*, refunds.issue | Serial checkout reserves exact item; signed sandbox webhook; refund ≤ captured; cancellation compensates stock | Branded storefront purchase flow end-to-end |
| 10 | CMS-GROWTH | 09 | content, marketing, promotions, analytics | pages, menus, themes(versioned), domains(verification), segments, campaigns, discounts, report definitions | `/v1/admin/cms|marketing|discounts|reports` | content.*, marketing.*, discounts.*, reports.read | Consent respected; discount eligibility/expiry/combination; metrics have definitions & freshness | Page/theme publish & preview; reports |
| 11 | OPERATIONS | 05–10 | shipping/payment/notification connector interfaces, webhook delivery, ops dashboards, MFA, API keys | webhook_endpoints/deliveries, api_keys, mfa factors | `/v1/admin/webhooks|api-keys`, ops health | apikeys.manage, webhooks.manage | Outage paths, security & a11y audits, perf fixtures, backup/restore drill | Operational recovery demo |
| 12 | LAUNCH | all | platform plans/usage, setup wizard, impersonation (JIT, audited), e2e matrix, runbooks | plans, usage_records, impersonation_grants | `/v1/platform/plans|usage|impersonations` | platform.impersonate | Full regression matrix; multi-tenant hardening | Pilot readiness checklist |

## 2. Cross-cutting conventions (apply from Phase 01 onward)

- **Tenancy**: every tenant-owned row has `tenant_id`; services filter explicitly AND PostgreSQL RLS (`app.tenant_id` set per transaction) is enforced for the runtime DB role (ADR-002). Unique constraints tenant-scoped.
- **Tenant resolution**: merchant admin = authenticated session + `X-Tenant-Id` validated against an active membership on every request; storefront = verified channel domain; platform = platform role. Client-supplied tenant id is never trusted without membership check (ADR-003).
- **API**: `/v1/*`, OpenAPI generated from shared zod schemas (route-coverage test fails if a route is undocumented), errors `{code,message,details,correlationId}`, cursor pagination `{items,nextCursor}`, `Idempotency-Key` on creation endpoints, optimistic locking via `version` on every PATCH.
- **Numbers**: money as `{amountMinor: string, currency}`; weights/decimals as strings backed by `NUMERIC(20,6)`; no JS float arithmetic for money/weight (decimal library from Phase 03/06).
- **Audit & outbox**: sensitive mutations write an `audit_events` row (append-only, redacted) and, where a domain event exists, an `outbox_events` row in the same transaction; worker relays at-least-once with retry/backoff/dead-letter; consumers dedupe via `processed_events`.
- **UI**: every list = server pagination/search/filter/sort + loading/empty/error/permission-denied states; every edit = zod validation, version conflict handling, unsaved-changes warning, real persistence. Navigation shows only implemented modules the tenant is entitled to and the user is permitted to use (no placeholder click targets).
- **Testing**: Vitest unit + integration against real PostgreSQL/Redis (docker compose), migration tests from clean DB, Playwright e2e using installed Chrome.

## 3. Out of scope until explicitly approved
Production deploys, pushes, real vendor ERP connectors without docs + credentials, live metal-rate feeds without licence, statutory tax/e-invoice correctness claims, real payment gateways beyond labelled sandbox.
