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

## ADR-015 Catalog model and behaviour — Accepted (Phase 02)
- Product ≠ variant: products carry content (title, description, SEO, options, attributes); variants carry identity (SKU, barcode, option values). SKUs are unique per tenant case-insensitively; option-value combinations unique per product. Serialized items are Phase 03.
- Product `status` (draft/active/archived) is separate from channel `publication`; storefronts show only active **and** published products with ≥1 active variant. Archiving unpublishes everywhere (outbox `ProductUnpublished`, an extension to the contract event list).
- Attributes are tenant-defined, typed (text/number/boolean/select), numbers stored as decimal strings. Jewellery measurements will be dedicated typed columns (Phase 03), not free attributes.
- Media: images only (JPEG/PNG/WebP/GIF, type sniffed from bytes, SVG rejected), ≤10 MB, stored at `tenants/{tenantId}/media/{id}`. Images are streamed through the API (tenant-scoped admin route; storefront route only for visible products) rather than public bucket URLs, so access rules stay in one place. A CDN can be added in front later (Phase 11).
- CSV import is a merchant catalog import (not a connector). Group atomicity: a product with any invalid row is skipped entirely; commit re-validates and refuses (409) if results differ from the preview; one transaction; at most once.
- Prices and stock are deliberately absent from catalog APIs until Phases 06/04.

## ADR-017 Jewellery measurements — Accepted (Phase 03)
- Canonical unit is the gram, `NUMERIC(20,6)`; arithmetic uses `decimal.js` (resolves OD-2) via `@uc/contracts/jewellery-math`. An ESLint rule bans `Number()`/`parseFloat`/unary `+` in measurement code.
- Accepted input units: g, mg, kg; ct (exactly 0.2 g) only for stones/components. Regional units such as tola are **not** accepted (ambiguous definitions; specs/04 "reject ambiguous units"). Input that would exceed 6 dp after conversion is rejected, never rounded.
- Raw input (`{value, unit}`) is stored next to canonical grams on specs, items and components; corrections keep the previous canonical values in `raw.previous`.
- Fine weight = Σ(metal component g × fineness) for multi-metal pieces, else net × fineness; rounded once, half-up, to the tenant's fine scale (default 3 dp); formula id and inputs are stored. Entered fine weights are allowed and cross-checked.
- Gross is never derived from net + stone; inconsistencies are **warnings** (other materials exist). Net > gross is blocked unless a reason is recorded, which puts the item into `pending_review` for a different user with `jewellery.review` (maker-checker).
- Purity fineness values are merchant configuration. Platform defaults (24K/22K/18K/14K, 999/925 silver, 950 platinum) are flagged unconfirmed until the merchant confirms them; changing a fineness never rewrites stored fine weights.
- HUID: optional, upper-cased, unique per tenant (not globally — an article can legitimately move between merchants on the platform). Format check is a tenant setting (BIS-style 6 alphanumerics by default, or free text) pending regulatory validation.
- Per-article availability/location/reservation is Phase 04; storefronts expose only design specs until then.

## ADR-018 Inventory ledger, balances and reservations — Accepted (Phase 04)
- **Ledger + projection in one transaction.** Every stock change is an append-only `stock_movements` row (UPDATE/DELETE revoked from the app role and blocked by trigger for everyone) plus a `stock_balances` update per (variant, location, condition) in the same transaction. Balances are never edited directly; corrections are new movements (adjustment, stocktake).
- **Oversell prevention is layered.** The engine locks balance rows in one global order (variant → location → condition, deadlock-free) and checks before writing; database CHECKs (`on_hand ≥ 0`, `on_hand ≥ reserved + committed`, holds only in sellable) are the backstop and map to 409 INSUFFICIENT_STOCK. Backorders stay disabled (OD-6).
- **ATP** = max(0, Σ sellable(on_hand − reserved − committed) over active eligible locations − buffer). Eligible = the channel's stock locations (none configured = all active), intersected with the member's location scope. Damaged, quarantine and in-transit stock is never sellable. Buffers do not apply to serialized pieces.
- **Reservations** `held → committed | released | expired`. Reserve = inline-expire due holds of the variant → lock its sellable balances → check ATP and pick one location (the requested one, or the one with most available) → post. One hold never spans locations (documented limitation). Each hold carries a per-tenant unique Idempotency-Key stored on the row; parallel retries return the same hold. Expired holds cannot be committed (RESERVATION_EXPIRED); expiry is idempotent (SKIP LOCKED + status re-check), runs inline and in the worker every 15 s.
- **No double counting.** Business operations write a `stock_documents` header whose (type, reference) is unique, so a GRN, count sheet or transfer receive can be posted once whatever its line count; stock-posting POST endpoints also require the generic Idempotency-Key (replays return the first response).
- **Serialized stock.** Serial-tracked variants keep quantity balances (1 per piece) *and* per-piece `location_id` + `stock_state` (not_received → in_stock → reserved/committed/in_transit → written_off). Holds name the exact piece; a partial unique index allows one active hold per piece. Only active (reviewed) pieces can be received; a piece in stock must be written off before it can be retired or rejected. The first piece receipt switches an untouched variant to piece tracking.
- **Transfers** are two-step: dispatch moves stock to the destination's `in_transit` condition; receive (destination scope) makes it sellable; cancel (source scope) returns it. No partial receipts yet.
- **Stocktakes / snapshots** carry `as_of`; per (location, source) a snapshot older than the last applied one is stored as `rejected_stale` with a reconciliation issue and changes nothing. Counts below current holds are rejected. Serial-tracked variants are excluded (pieces are checked individually).
- **Reconciliation** (worker every 10 min + on demand) compares balances with the ledger sum, open reservations and serialized pieces. Mismatches open deduplicated issues; nothing is auto-corrected — a person fixes it with an adjustment/stocktake and resolves the issue with a note. Phase 05 reuses issues and snapshots for ERP imports.
- **Authority (OD-3) is unchanged:** without a connector the commerce ledger is authoritative. Periodic import-only ERP sources (Phase 05) will never be presented as zero-oversell.

## ADR-019 Connector framework and honest support tiers — Accepted (Phase 05)
- **Tiers, not claims.** A connector is `available` only when built and tested end to end. Today: generic CSV/XLSX file import and a deterministic simulator. TallyPrime, Jwelly, Acme Infinity and Jewels Prime are listed as `blocked` with the exact inputs each is waiting for (registry in `packages/contracts/src/connectors.ts`, shown in the app). Blocked connectors cannot be connected (409 CONNECTOR_UNAVAILABLE); each has a per-tenant discovery checklist (specs/05 qualification fields).
- **SDK boundary.** `packages/connector-sdk` holds the adapter contract (capabilities, testConnection, pullItems, pushOrder, health), the mapping engine (source column → canonical field, exact unit conversion mg/kg/ct → g, per-field errors) and file parsing (CSV by RFC 4180, first XLSX sheet by content sniffing, max 5,000 rows / 2.4 MB). Everything after mapping (dedupe, ownership, stock, retries) is shared platform code, so a vendor adapter only implements what its vendor supports.
- **Preview then commit.** Every file upload or pull is staged as a sync job; rows get create / update / unchanged / stale / delete / error. Nothing outside staging changes until commit. Commit is atomic (refused while rows have errors) or partial (valid rows only, each row in a savepoint). Row errors are downloadable as CSV (formula-injection safe).
- **Dedupe and ordering.** `external_records` maps (connection, record type, external ID) → variant or serialized piece with version, source time and checksum: re-imports are `unchanged`, older versions are `stale` and skipped. Deleted/sold rows are flagged as issues, never applied as deletions. Checkpoints only move forward.
- **Field ownership.** Per connection: title (default commerce), SKU, weights, stock, piece receipts (default ERP). Imports never overwrite commerce-owned fields; manual receipts, adjustments, transfers and stocktakes on ERP-owned stock are refused (409 FIELD_OWNED_BY_ERP). Changing ownership or disconnecting needs a reason (audited).
- **Stock through the ledger.** Design quantities become an ERP snapshot per location (`stock_counts` source `erp`, now carrying `connection_id`); a snapshot older than the last one applied for the same connection and location is stored as stale with an issue. Quantities below current holds are reported, never forced. Pieces are received through the ledger. Reconciliation compares the last ERP figures with balances; a person takes the source value (ledger adjustment, reason `erp_reconciliation`) or keeps ours, with a note.
- **Outbound order export.** `outbound_commands` with a reference unique per connection; the worker relays them (SKIP LOCKED, connection row locked while adapter state changes), retries with exponential backoff and parks exhausted commands as `failed` exceptions with events. A retry after a timeout reuses the reference, so the ERP never gets a duplicate order. Checkout (Phase 07) will enqueue into the same pipeline.
- **Secrets.** Connections store a credential *reference* only (`vault:`/`env:`/`secretsmanager:`, DB CHECK). No vendor secrets exist in this build.
- **Not built yet (tracked):** live vendor adapters, the on-premise desktop agent (design only, needs a pilot), media pull from ERPs, signed inbound webhooks.

## ADR-020 Set-based ledger posting and bulk ERP import — Accepted (Phase 05 follow-up)
- `postMovements` aggregates lines per balance key as before, then per chunk of 1,000 keys: one multi-row `insert … on conflict do nothing`, one `select … for update` ordered by (variant_id, location_id, condition collate "C") — the same global order as the previous one-key-at-a-time loop (uuid order equals lowercase-hex string order), so it stays deadlock-free against other posters — validation in memory, one `update … from (values …)`. Shortage reporting and the all-or-nothing behaviour are unchanged; the DB CHECK constraints still guard every row.
- ERP import commit creates brand-new designs (no external record, SKU unused, SKU unique in the file) in multi-row statements inside a savepoint. On any error the savepoint is rolled back and those rows go through the per-row path, which produces the precise per-row errors (partial) or the atomic failure. Everything else (updates, links by SKU, pieces, deletions) keeps the per-row path.

## ADR-021 Metal rates, pricing engine and quotes — Accepted (Phase 06)
- **Rates are append-only proposals** (metal + purity + currency, canonical NUMERIC(20,6) per gram; per 10 g / per kg converted exactly, over-precise input rejected; raw input kept). A second person approves (service check + `metal_rates_four_eyes_ck`); values are immutable (trigger); the current rate is the latest approved with `effective_from <= now`. Rollback = approve the old value again. Resolves OD-8: manual source + a deterministic, clearly labelled simulator; licensed feeds stay blocked.
- **Freshness**: a rate is stale when its *source time* is older than `rate_max_age_minutes` (default 1440). Policy `block` (default) refuses to price; `use_last_approved` prices and flags the quote. The worker emits `RateStale` once per rate.
- **Rules are typed data, never code** (zod DSL): base (metal by gross/net/fine/item basis, or list price), making (per gram / tiered / per piece / % of metal / per line), wastage (explicit %, valued at the rate, shown separately), stones (per carat / per stone by kind + grade; a missing rate fails), charges, discount (allocated by largest remainder), tax rule reference. Draft → published (immutable) → superseded/retired; publishing checks same-priority overlapping conditions (409 RULE_CONFLICT) and, when rule review is on (default), author ≠ publisher.
- **Rounding policy**: each component computed exactly for the whole line and rounded once to minor units half-up; tax rounded once on the discounted base; total = sum of parts (DB CHECK on quotes). Prices are tax-exclusive; there is no tax-inclusive mode, so tax is never counted twice.
- **Precedence**: for a channel, channel-specific books before all-channel books, then book priority, then name; within a book, published rules by priority then name; first match wins. The breakdown names book, rule version and rate.
- **Quotes** (OD-4): immutable records (lines, breakdowns, rate IDs, rule versions) with TTL (default 15 min). Revalidate: unchanged + valid → same quote; otherwise a new quote supersedes it; failures → "unavailable" without changing anything. Phase 07 checkout uses revalidate.
- **Tax** (OD-7): merchant-entered rules, `pending_validation` until someone records a validation note; changing a validated rule's rate or scope puts it back to pending. No rates are pre-filled.

## ADR-022 Orders, checkout, sandbox payments and quotations — Accepted (Phase 07)
- **Server prices, client acknowledges.** Checkout re-prices with current rates/rules; a different total returns 409 PRICE_CHANGED with a new quote the shopper must acknowledge. The acknowledged total must equal the server quote; it never sets the price.
- **Holds before orders.** Every line is held through `reserveStock` inside the same transaction as the order (all-or-nothing). Storefront orders keep holds for the payment window (`checkout_hold_minutes`, default 30); staff orders confirm (commit) at once or wait up to 24 h for approval at/above `approval_threshold_minor` (approver ≠ creator).
- **Immutable commercial record.** Order lines store the full priced line (measurements, book, rule version, rate, breakdown) and cannot change except to re-point an expired hold; totals cannot change; cancellation is a state + compensation, never an edit.
- **Payment confirms, stock commits.** On capture, holds commit; an expired hold is re-reserved, and if stock is gone the order goes `on_hold` rather than overselling. Cancellation releases held and committed stock through the ledger; a captured payment becomes `refund_due` (executed in Phase 09). Pending payments are not closed on cancel, so a late capture is recorded, not lost.
- **Sandbox gateway only** (`PAYMENTS_SANDBOX_*`, refused in production): HMAC-SHA256 over the canonical payload, timing-safe verification, replay protection by event ID, amount/currency check. A real PSP adapter plugs into the same webhook handling.
- **Quotations** freeze their price as a price quote valid until the chosen date (≤ `quotation_max_days`); conversion uses that frozen price (an accepted quote keeps its terms until expiry) and still applies holds and approval.
- **ERP export & double subtract.** Confirmed orders queue `ORDER:<number>` for connections with `exportOrders` (stable reference → no duplicate ERP order). Units committed to orders an ERP connection acknowledged are added back to that connection's stock figures until shipped, so the same sale is never subtracted twice.

## ADR-023 B2B companies, buyer identity, credit and the buyer portal — Accepted (Phase 08)
- **Buyers are users with a third audience.** A buyer is a global user linked to companies of one tenant (`company_buyers`); `buyer` sessions use their own cookie (`uc_b_sess`) and can never call admin/platform APIs, and staff sessions cannot call the buyer API. The tenant comes from the B2B storefront domain (Host, or `X-Storefront-Host` proven by the gateway key), never from the client; the company comes from the buyer's own links (`X-Company-Id` only chooses among them).
- **CSRF for the portal**: `/v1/storefront/b2b/*` requires `X-UC-CSRF` and, when present, an Origin on the same storefront domain.
- **Portal hosting**: `apps/buyer-portal` is a Next.js app with a same-origin Node proxy that forwards only `/v1/storefront/*` and adds the shopper's domain and the gateway key server-side. Each merchant's portal therefore runs on its own domain with HttpOnly cookies, and the key never reaches the browser.
- **Company pricing**: a book assigned to a company wins over channel and all-channel books and is excluded for every other buyer and for staff calculations. List prices carry an optional MOQ. MOQ, minimum order value and the catalog restriction are enforced on the server when pricing and again when ordering.
- **Credit is an append-only ledger** (order charge/release, payment, advance, adjustment with reason). Exposure is the sum of the entries. An order takes the company row lock, checks status and `exposure + total ≤ limit` (prepaid: limit 0), then charges in the same transaction. Cancellation posts a release. Nothing edits an entry (DB trigger).
- **Two approval layers**: an order above the buyer's own limit waits for a company approver or admin (`awaiting_buyer_approval`, never the same person). After that, the merchant's Phase 07 threshold still applies (`awaiting_approval`). Holds are kept throughout; expiry releases them.
- **RFQs** become Phase 07 quotations (price frozen until valid-until). A buyer may accept a subset of lines, which creates an order at the frozen prices with credit and approvals applied; the worker expires stale RFQs.
- **Not real**: GSTIN is format-validated only. ERP-authoritative credit is displayed as not synced. Invitations are one-time links shown to staff (no email until Phase 11).

## ADR-024 Storefront customers, fulfilment, returns, refunds and the B2C storefront — Accepted (Phase 09)
- **Customers are merchant-owned identities**, not platform users: `customers` (tenant + e-mail unique), their own argon2id credential, own session table and cookie `uc_c_sess` (7 days, HttpOnly, SameSite=Strict) on the store domain. The same e-mail at two merchants is two accounts. Same protections as staff sign-in (per-IP/e-mail throttling, lockout, uniform errors). `/v1/storefront/account/*` requires the CSRF header and a same-domain Origin.
- **Order linkage**: an order is linked to a customer only when placed while signed in *and* with the CSRF header; guest orders are never linked by e-mail (unverified).
- **Consent** is an append-only log (`consent_events`, DB trigger); the preference shown is the latest event per channel. Viewers no longer get `customers.read` (customer data is sensitive).
- **Shipping moves stock out**: dispatch posts ledger movements `shipment` (on-hand −q and committed −q at the commitment's location); the commitment records `fulfilled_quantity` and becomes `fulfilled`; a piece becomes `shipped`. Reconciliation and ERP add-back count only the unshipped remainder. Carrier/tracking are typed by staff and labelled not tracked.
- **No cancel after shipping**: whole-order cancel is refused once anything shipped (`ORDER_SHIPPED`); "cancel unshipped items" releases only the remainder and adds exactly its value (line total split by unit, remainder on the first units) to the refund due.
- **Returns** are requested (customer or staff) within `return_window_days` after the latest delivery/dispatch, approved or rejected, then received: restock (`return_receive`, piece back `in_stock`) or not (piece `written_off`). Return values use the same exact unit split.
- **Refunds** reserve their amount on the payment under a row lock (`payments.refunded_minor`, DB check ≤ amount) and settle only through the gateway's signed callback (same HMAC/replay path as captures); a declined refund frees the amount. The refund row's amount/payment never change (trigger). Only the sandbox gateway exists.
- **Customer messages** are recorded with status `not_sent` and a reason until a notification connector exists (Phase 11); nothing claims delivery.
- **Storefront app** `apps/storefront` (port 3103) uses the same server-side gateway-key proxy as the buyer portal; it never forwards the B2B portal API.

## ADR-025 Online store content, promotions, marketing audiences and reports — Accepted (Phase 10)
- **Content = drafts + immutable versions.** Theme, header/footer menus, banner and pages are `site_documents` per storefront channel. Staff edit drafts; publishing validates the content for its kind, appends an immutable `site_document_versions` row (DB trigger) and copies it to `published`. Rollback publishes an old version again as a new version. The storefront API serves only `published` (and only `live` documents); publishing the theme also updates the channel theme.
- **Preview** uses a 15-minute HMAC token bound to tenant + channel (`PREVIEW_TOKEN_SECRET`, refused at its development default in production), sent by the storefront as `X-Preview-Token`. A wrong, expired or other-store token silently yields published content.
- **Domains** are added `pending` with a random TXT token and verified by a real DNS lookup of `_uc-verify.<host>`; `.localhost`/`.test` hosts are verified without DNS outside production only. Hostnames stay globally unique; only verified domains resolve. TLS for custom domains is a hosting concern (Phase 12).
- **Promotions are applied before tax, by the server.** Eligible promotions (status, window, channel, currency, minimum spend, segment, total and per-customer limits) are planned on the order base (line amounts after rule discounts): percent → half-up, fixed → capped; split across lines by largest remainder, then across each line's components; tax is computed on the discounted amounts. Combination: all apply only if all are combinable, otherwise the single largest. Checkout re-evaluates with the discount rows locked (`FOR UPDATE`), so usage limits hold under concurrency; a promotion lost at checkout changes the price (409 PRICE_CHANGED). Redemptions are append-only; a used discount's code and amount cannot change.
- **Audiences, not sends.** Segments are typed rules evaluated in SQL; consent is always the latest consent event per channel. Preparing a campaign snapshots only consented, reachable customers (counting the excluded); recipients stay `not_sent` until a notification connector exists (Phase 11).
- **Reports** are fixed SQL over the platform's own records, with each metric's formula published in `REPORTS`, calendar days in the store time zone, store-currency amounts only (other currencies counted in notes), `generatedAt` on every response, CSV export with formula-injection protection. No CAC/ROAS: ad spend is not recorded. Attribution is the latest UTM-tagged arrival in the browser session, captured at checkout.

## ADR-027 Launch: plans and usage limits, setup checklist, just-in-time support access — Accepted (Phase 12)
- **Plans** are global rows (`plans`) with limits; `tenants.plan_key` defaults to `pilot` (no limits). Products, staff
  seats (active members + pending invitations), locations and storefront domains are **hard** limits, checked in the
  creating transaction under a per-tenant, per-kind advisory lock so concurrent creates cannot overshoot. Orders per
  month is **soft** (shown as a warning, a sale is never refused for plan reasons). ERP sync is not limited: the
  merchant's system of record is never refused; usage then shows *over*. Usage is computed live from the tables (no
  counters). Plans carry no price — billing is blocked on a provider. Starter/Growth limits are proposals to confirm
  commercially. Downgrades never delete anything.
- **Setup checklist** is computed from real records (profile, location, channels, staff, products, approved rates for
  metal-rate presets, payments, verified domain, import/connection, first order); nothing is ticked by hand. It
  replaces the Phase 01 Home checklist in the UI (the old `HomeSummary.setupChecklist` field stays for contract
  stability).
- **Support access** (spec 03/06 "just-in-time, audited, approved, visible"): an operator with
  `platform.support.request` asks with a reason and 15–120 minutes; a merchant **owner** (`support.manage`, not given
  to admins) approves or denies; only the requesting operator can start it. Start returns a one-time, 60-second
  handoff code (Redis, SHA-256 key, `GETDEL`) that the merchant admin redeems on its own origin, so the design works
  when admin and console live on different domains. The session is a merchant-audience session bound to the grant
  (`sessions.support_grant_id`): resolved only while the grant is approved and unexpired, GET-only
  (`SUPPORT_READ_ONLY`), limited to that tenant, with the viewer role's read permissions (no customer personal data,
  no audit log), and cannot change account security. Every request is audited (`support.request`); revoke ends the
  sessions at once. If Redis is down, support start fails closed.
- **Pilot connector checklist** reads a connection's real sync history in spec 05 order; "production support" is
  always *blocked* until vendor acceptance.
- **Hardening** is enforced by tests driven by `API_ROUTES`: every admin route → 401 without a session and 403 for a
  non-member; every platform route → 401 with no or a merchant session; a tenant transaction sees zero rows of other
  tenants in every table with a tenant policy.

## ADR-026 Operations: webhooks, automations, API keys, MFA, health and recovery — Accepted (Phase 11)
- **Outbound webhooks** fan out from domain events in a worker consumer (deduped per consumer + event id), one delivery per subscribed endpoint. The worker leases due rows with SKIP LOCKED, POSTs outside any transaction with `X-UC-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "t.body")>` and `X-UC-Event-Id`, 10 s timeout, no redirects, backoff 30 s × 2^(n−1) capped at 6 h, `dead` after 8 attempts; staff can replay. URLs must be https and resolve to public addresses (checked when saved and again at delivery); `WEBHOOKS_ALLOW_PRIVATE_TARGETS` exists for development/tests only and is refused in production.
- **Secrets the platform must use itself** (webhook signing keys, TOTP seeds) are sealed with AES-256-GCM under `SECRETS_ENCRYPTION_KEY` (development default refused in production) and shown once. Connector credentials stay secret-store references.
- **Automations** are typed rules: trigger from the webhook event allowlist, conditions (minimum order total, channel), action from an allowlist (webhook delivery, staff inbox notification). Actions never write domain events, so rules cannot trigger each other; every evaluation is logged once per (rule, event).
- **API keys** are read-only (GET), bound to one tenant, hashed, expiring and revocable; a key acts for its creator with permissions = creator's current permissions ∩ key scopes, so removing the member disables the key.
- **MFA** (RFC 6238 TOTP, implemented without external libraries) for staff and platform audiences: a correct password returns `401 MFA_REQUIRED` with a 5-minute, 5-attempt challenge; codes are single-use (last step stored); 10 hashed recovery codes; turning it off needs password + code. A merchant can require MFA for owners/admins; enrolment lives outside the tenant shell so the requirement cannot lock anyone out of setting it up. Buyer-portal and storefront accounts are out of scope for MFA in this phase.
- **Operations health** is computed live from the tables (outbox backlog/dead, webhook failures, ERP export lag, connector freshness, reconciliation aging, stale rates, payment failure rate) with documented thresholds; platform operators see global figures and replay dead outbox events (safe: consumers dedupe by event id).
- **Recovery**: `scripts/backup.sh` + `scripts/restore-drill.sh` + `scripts/invariants.sql`; drills recorded in `docs/runbooks/BACKUP-RESTORE.md`. Proposed RPO 15 min / RTO 1 h needs managed PITR (Phase 12 hosting).
- **Provider interfaces** for payment, shipping and notification gateways live in the connector SDK; the registry reports the sandbox payment gateway and blocked real providers — nothing is presented as connected.

## ADR-016 Generative AI usage — Proposed (no AI in the product today)
- Nothing in the specs requires an LLM, and specs/00 puts "AI-autonomous financial approval" out of scope. **No OpenAI (or other LLM) integration exists or is planned in Phases 01–12 by default.**
- If wanted later, only as an optional, tenant-entitled, human-reviewed assistant behind an adapter interface (provider-agnostic, keys in a secret store, prompts/outputs audited, no customer PII sent without consent), for content tasks such as: product description/SEO drafts, image alt-text suggestions, CSV/ERP column-mapping suggestions (Phase 05). Never for prices, metal rates, tax/GST/HSN, stock, approvals, or anything financial/legal.
- Requires explicit user decision (provider, data-processing terms, budget) before any work.

---

## Open decisions (Proposed — safe defaults applied, confirm before the dependent phase)

| ID | Topic | Safe default | Needed by |
|---|---|---|---|
| OD-1 | Money representation in DB | `amount_minor BIGINT` + `currency CHAR(3)` for money; `NUMERIC(20,6)` for weights/rates; rounding half-up at defined stages | Phase 06 |
| OD-2 | Decimal library | `decimal.js` (configured precision 40) in pricing engine | Phase 03/06 |
| OD-3 | Inventory authority default | ERP-authoritative when a connector with `stockRead` is configured, otherwise commerce-authoritative; per-connector granularity recorded | Phase 04/05 |
| OD-4 | Checkout rate-lock moment | lock at quote creation with TTL (default 15 min), revalidate at checkout; configurable per channel | Phase 06/07 |
| OD-5 | Invoicing authority | ERP if merchant chooses; otherwise commerce issues "proforma/reference" documents only, never self-labelled tax-compliant | Phase 07/09 |
| OD-6 | Backorder | **Applied in Phase 04:** disabled (DB-enforced); negative stock only with an explicit approved policy in a later phase | Phase 04 |
| OD-7 | Tax | versioned tax-rule provider with merchant-entered rates flagged "pending accountant validation"; no hardcoded GST rates | Phase 06/07 |
| OD-8 | Metal-rate provider | manual source only until a licensed provider + credentials are supplied | Phase 06 |
| OD-9 | ERP vendor | simulator + CSV/XLSX only until vendor docs + sandbox credentials are supplied | Phase 05 |
| OD-10 | MFA method for platform operators | TOTP + recovery codes | Phase 11 |
