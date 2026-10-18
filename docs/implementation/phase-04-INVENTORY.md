# Phase 04 — INVENTORY: ledger, balances, reservations — task plan

## Repo inspection summary (start of phase)
- Phases 01–03 approved and pushed (`0168b35`). 211 unit/integration + 16 E2E green. Docker Desktop was stopped at
  the start of this phase; restarted and infra brought back up.
- Building blocks available: locations with membership scope (Phase 01), variants (Phase 02), serialized items with
  lifecycle (Phase 03), outbox + worker relay (Phase 01), audit, idempotency.
- Risks: oversell under concurrency, double counting (replayed movements, snapshots), balances drifting from the
  ledger, expired holds still blocking stock, location-scoped operators acting outside scope.

## Scope
Append-only **stock ledger** (movements) with **balances** as a transactional projection per variant × location ×
condition (sellable, damaged, quarantine, in transit); **ATP** per variant overall, per location and per channel
(`max(0, Σ sellable(on_hand − reserved − committed) − buffer)`); **reservations** `held → committed | released |
expired` with row-locked check-and-reserve, idempotency keys and TTL; inline + worker **expiry**; **receipts,
adjustments (reason codes), condition changes, two-step transfers (in transit), stocktakes** (snapshots with
monotonic `as_of`; variance posted as movements); **serialized stock** (each piece has a location and stock state;
holds reserve that exact piece); **reconciliation** (ledger vs balances check → issues, resolvable) in the worker and
on demand; per-variant stock settings (tracking quantity/serial, unit pcs/g, buffer); admin dashboards and
conflict/error views. Backorders stay disabled (OD-6): balances can never go negative or below reservations.

Not in scope: checkout/order flows (Phase 07 calls the reservation API), fulfilment/shipping decrement (Phase 09),
ERP snapshots and acknowledged-sale matching (Phase 05 builds on the snapshot + issue primitives here).

## Data model (migration 0007 + 0008)
| Table | Notes |
|---|---|
| stock_settings | per tenant: default buffer, reservation TTL minutes, backorder policy (disabled) |
| variant_stock_settings | per variant: tracking (quantity/serial), unit (pcs/g), buffer override |
| channel_stock_locations | which locations feed a channel's ATP (none configured = all active locations) |
| stock_balances | (variant, location, condition) on_hand / reserved / committed NUMERIC(20,6); CHECKs: all ≥ 0 and on_hand ≥ reserved + committed |
| stock_movements | append-only (trigger + no UPDATE/DELETE grant); deltas for on_hand/reserved/committed; type, reason, actor, reference, operation id |
| stock_documents | one header per posted operation; (type, reference) unique so a document number posts once |
| reservations | status held/committed/released/expired; variant, location, optional serial item, qty, channel, reference, expires_at, idempotency key unique per tenant |
| transfers + transfer_lines | dispatched → received / cancelled |
| stock_counts + stock_count_lines | stocktake snapshots: counted vs expected, variance; applied / rejected_stale |
| reconciliation_issues | domain `inventory` (Phase 05 reuses): kind, severity, details, open/resolved |
| serial_items (+ location_id, stock_state) | not_received / in_stock / reserved / committed / in_transit / written_off |

## Screens / actions (merchant admin, all under Inventory)
| Route | Permission | Backend | Tests |
|---|---|---|---|
| `/inventory` dashboard (ATP table, filters location/channel/low stock, totals, open issues) | inventory.read | `GET /v1/admin/inventory/levels`, `/summary` | isolation, scope, ATP math |
| `/inventory/variants/:id` (balances, ledger, reservations, settings, actions: receive, adjust, condition change, hold) | inventory.read / adjust / reserve | `GET /inventory/variants/{id}`, `POST /inventory/receipts`, `/adjustments`, `/condition-changes`, `PUT /inventory/variants/{id}/settings` | reasons, negative guard, double posting |
| `/inventory/reservations` (active/expired, release, commit) | inventory.read / reserve | `GET/POST /inventory/reservations`, `POST /{id}/commit`, `/{id}/release` | concurrency, expiry, idempotency |
| `/inventory/transfers` (+ create, receive) | inventory.transfer | `GET/POST /inventory/transfers`, `POST /{id}/receive`, `/{id}/cancel` | scope, in-transit |
| `/inventory/counts` (stocktake: enter counts, preview variance, apply) | inventory.adjust | `GET/POST /inventory/counts` | stale snapshot, variance movements |
| `/inventory/issues` (reconciliation, resolve) | inventory.read / adjust | `GET /inventory/issues`, `POST /inventory/reconcile`, `POST /issues/{id}/resolve` | detection, resolution |

## Acceptance cases
| ID | Case |
|---|---|
| I-01 | Two (and many) concurrent holds for the last unit/piece → exactly one succeeds; balances never oversold |
| I-02 | Expired holds release stock (inline on next reserve and by the worker); expiry is idempotent and emits `ReservationExpired` |
| I-03 | No double count: replayed receipt (same reference / Idempotency-Key) counts once; balances always equal the ledger sum; reconciliation detects tampering |
| I-04 | Adjustments need reason + permission; cannot go negative or below reserved+committed; audited |
| I-05 | Transfers move stock through in-transit; scoped operators only act in their locations |
| I-06 | Stocktake posts variance movements; older `as_of` snapshot rejected as stale (recorded, not applied) |
| I-07 | Serialized: a piece is in one place, holds reserve that exact piece, retired/written-off pieces leave stock |
| I-08 | ATP: buffer, channel locations, conditions (damaged/in transit not sellable) |
| I-09 | Ledger append-only (DB), tenant isolation of all inventory data |
| I-10 | OpenAPI coverage; E2E: receive → hold → commit/release in the admin |

---

## Results (2026-10-18) — status: approved (2026-10-19)

### What was built
- **DB** (migrations 0007 generated, 0008 custom): 12 inventory tables (incl. `stock_documents`), `serial_items.location_id/stock_state`, RLS on all of them, append-only trigger + revoked grants on `stock_movements`, `inventory.reserve`/`inventory.read` role data migration, default `stock_settings` for existing tenants.
- **Engine** `packages/db/src/inventory.ts` (shared by API and worker): `postMovements`, `reserveStock`, `commitReservation`, `releaseReservation`, `expireReservations`, `reconcileInventory`, `openIssue`, `setSerialState`. Exact decimal math in `packages/contracts/src/stock-math.ts` (lint rule bans JS number coercion in all inventory code).
- **API** `apps/api/src/modules/inventory/*`: 28 endpoints under `/v1/admin/inventory` (see [PERMISSIONS.md](../api/PERMISSIONS.md#phase-04--inventory)); OpenAPI regenerated (91 paths). Error filter maps engine errors and DB stock CHECK violations to 409 `INSUFFICIENT_STOCK`.
- **Worker** `apps/worker/src/inventory-jobs.ts`: hold expiry every 15 s, reconciliation every 10 min, both cross-tenant and failure-tolerant.
- **UI** (merchant admin, one nav entry + section tabs): stock levels dashboard with filters/summary, variant stock page (balances, ATP by location/channel, receive/adjust/condition/hold dialogs, pieces with hold/write-off, holds with commit/release, ledger), reservations, transfers (list/new/detail with receive/cancel), stocktakes (list/new with variance preview/detail), ledger, reconciliation issues (run check, resolve), settings (defaults + channel stock locations). Serialized items list/detail now show stock state and location.
- **Seed**: DEMO opening stock posted through the real engine (`DEMO-GRN-*` references, notes labelled DEMO); Aurum pieces AUR-T-0001/2 at the main warehouse, AUR-T-0003 at Mumbai.

### Commands and outcomes
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 0 errors / 0 warnings (no-float rule extended to inventory code) |
| `pnpm typecheck` | 0 | all packages |
| `pnpm build` | 0 | all apps (12 new inventory routes in the merchant admin) |
| `pnpm test` | 0 | **234 tests**: contracts 45 (+5 stock math/schemas), db 25, ui 2, api 155 (+16 inventory), worker 7 (+2 inventory jobs) |
| `pnpm test:e2e` | 0 | **19 Playwright tests** (+3 inventory flows) |
| `pnpm audit --audit-level high` | 0 | 0 high/critical (3 moderate reported) |
| `pnpm openapi:generate` | 0 | `docs/api/openapi.json` updated |

### Acceptance coverage
| ID | Status | Evidence (`apps/api/test/integration/inventory.spec.ts` unless noted) |
|---|---|---|
| I-01 concurrent last unit / piece | PASS | 12 parallel HTTP holds for 1 unit → exactly 1×201, 11×409, reserved = 1 = ledger; 8 parallel holds of one piece → exactly one wins |
| I-02 expiry | PASS | expired hold refused at commit (`RESERVATION_EXPIRED`); inline expiry frees stock on next reserve; worker pass expires once, second pass 0 (API test + `apps/worker/test/inventory-jobs.spec.ts`); `ReservationExpired` events |
| I-03 no double count | PASS | Idempotency-Key replay returns the same operation; re-sent reference → 409 DUPLICATE; balance = ledger sum; parallel same-key holds → one hold; tampered balance → one critical issue (deduped), resolved with note |
| I-04 adjustments | PASS | note required; viewer 403; below zero / below holds → 409 with nothing written; reason code + note in ledger; audit count increments |
| I-05 transfers + scope | PASS | dispatch → destination in transit (not ATP); Mumbai-only operator cannot dispatch from/adjust at main, sees only Mumbai balances, receives at Mumbai; double receive 409; cancel returns stock; E2E transfer received by scoped operator |
| I-06 stocktake | PASS | dry run writes nothing; applied count posts ±variance movements; older `asOf` → `rejected_stale` + issue + `InventorySnapshotReceived{status: rejected_stale}`, stock unchanged; below holds → 409; future `asOf` → 400 |
| I-07 serialized | PASS | pending-review piece cannot be received; receipt switches variant to piece tracking; quantity lines refused; exact-piece hold; held piece cannot be written off or retired; write-off → `written_off`, location cleared, retire then allowed; piece transfer in transit → in stock |
| I-08 ATP | PASS | damaged not sellable; buffer reduces ATP and blocks over-holds (details show atp/buffer); out-of-stock filter; channel stock locations limit channel ATP and holds |
| I-09 append-only + isolation | PASS | UPDATE/DELETE on `stock_movements` fail for owner (trigger) and app role (permission denied); other tenant gets 404/400 and empty lists; role templates = DB roles (J-09 test) |
| I-10 OpenAPI + E2E | PASS | route coverage test (91 paths); `e2e/tests/inventory.spec.ts` (receive → duplicate reference blocked → hold → commit → release; piece hold + scoped transfer receive; stocktake preview/apply + clean reconciliation); screenshots `inventory-variant.png`, `inventory-dashboard.png` |

### Issues found and fixed during this phase
1. E2E: the Phase 01 navigation test asserted Inventory was hidden (correct until this phase) — now asserts Inventory is visible and Integrations (Phase 05) hidden.
2. E2E: a `selectOption` ran against the previous page's "Location" filter before client navigation finished — tests now wait for the new page heading.
3. E2E: ambiguous locators (the `To` label matched two fields; the `Stocktake` type cell also matched the reason badge) made exact.
No product defects surfaced from the test runs; all 16 new API tests passed on their first run (which is why each asserts concrete balances, ledger sums and event rows rather than status codes only).

### Known gaps / carried over
- A hold is always at one location (no split holds); transfers have no partial receipts.
- Condition changes are quantity-only; a damaged piece is written off (no per-piece condition yet).
- A piece that goes back to `pending_review` after receipt still counts in on-hand/ATP but cannot be held.
- Committed stock is decremented by fulfilment in Phase 09 (`commitment_release` is used only for releases today); checkout/order reservations are Phase 07 callers of the same engine.
- ERP snapshots, authority per connector and acknowledged-sale matching: Phase 05 (reuses `stock_counts` source `erp`, `reconciliation_issues`). The `stocktake_variance` issue kind is reserved for that and not emitted yet.
- No CSV upload for stocktakes yet (manual entry with SKU search).
- Committed and pushed after approval on 2026-10-19.
