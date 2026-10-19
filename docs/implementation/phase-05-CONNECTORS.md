# Phase 05 — CONNECTORS: ERP connector framework — task plan

## Repo inspection summary (start of phase)
- Phases 01–04 approved and pushed (`5060d81`). 234 unit/integration + 19 E2E green.
- Building blocks: catalog (products/variants, media), serialized items, inventory engine (ledger, snapshots with
  monotonic `as_of`, reconciliation issues), outbox + worker, idempotency, audit.
- Vendor research (docs/integrations/ERP-VENDOR-RESEARCH.md): only TallyPrime publishes integration docs; Jwelly,
  Acme Infinity and Jewels Prime publish none. No vendor credentials or sandboxes are available (OD-9).
- Risks: duplicate records on re-import, ERP overwriting commerce-owned content, stale/out-of-order feeds,
  double-subtracting sales, claiming vendor support we have not tested, secrets in logs, polling sold as real-time.

## Scope (built and tested)
- **Connector SDK** (`packages/connector-sdk`): adapter contract (capabilities, testConnection, fetchItems,
  pushOrder, health), mapping engine (source column → canonical field, unit transforms g/mg/kg/ct, required checks),
  CSV/XLSX parsing, and a **deterministic ERP simulator** (catalogue + stock with versioned changes, deletions,
  out-of-order versions, outbound orders with injectable failures/timeouts).
- **Connector registry** with honest tiers: `file_csv` and `simulator` available; `tallyprime`, `jwelly`,
  `acme_infinity`, `jewels_prime` listed as **blocked** with their exact missing dependencies; vendor discovery
  checklist per tenant (status + answers).
- **Connections**: credential *reference* only (never a secret value), settings, **field ownership matrix**
  (catalog title/description = commerce, SKU/weights/stock = ERP by default), active mapping version.
- **Versioned field mappings** with sample preview.
- **Sync jobs** (preview → commit, like catalog imports): file upload or simulator pull; staged rows with action
  create / update / unchanged / stale / delete / error; atomic or partial commit; per-row error CSV export;
  external record map (dedupe), checkpoints, stale snapshot protection, deletion policy = flag (never silent delete).
- **Apply**: designs → product + variant (+ unit), pieces → serialized items (jewellery tenants), stock → ERP
  snapshot per location through the inventory ledger (`stock_counts` source `erp`).
- **Field ownership guard**: manual receipts/adjustments/stocktakes on ERP-owned stock are refused.
- **Reconciliation**: ERP snapshot vs balances → `erp_stock_mismatch` issues; resolve by "accept ERP value" (posted
  through the ledger) or "keep ours" with a note.
- **Outbound order simulator**: idempotent commands (unique reference), worker relay with retry/backoff → `failed`
  exception state; retry after timeout never duplicates the ERP order.
- **Admin UI**: Integrations catalog + blocked dependency tracker, connection detail (overview/freshness, ownership,
  mapping, jobs, records, outbound, simulator controls, discrepancies), job preview/commit screen.

## Not in scope / blocked (tracked in docs/integrations/BLOCKED-DEPENDENCIES.md and in the app)
- Live vendor connectors (Tally, Jwelly, Acme Infinity, Jewels Prime): blocked on docs / sandbox / pilot.
- Desktop agent (Tally): design only until a local pilot is confirmed.
- Media pull from ERPs (formats unknown); signed inbound `/v1/integrations/*` webhooks (no vendor sends them yet).
- Real order export from checkout (Phase 07 enqueues commands into the same outbound pipeline).

## Acceptance cases
| ID | Case |
|---|---|
| X-01 | Initial import from CSV and XLSX: preview writes nothing; commit creates products/variants/stock once |
| X-02 | Re-import of 1000 records creates no duplicates (unchanged), changed rows update only ERP-owned fields |
| X-03 | Out-of-order (older version) rows are stale-skipped; unknown location/purity, malformed weight unit → row errors |
| X-04 | Deleted records are flagged (issue), never silently deleted; partial commit applies valid rows only |
| X-05 | SKU collision with a commerce-only product is an error unless linking by SKU is enabled |
| X-06 | Field ownership: ERP import never overwrites commerce-owned title; manual stock change on ERP-owned stock refused |
| X-07 | Simulator incremental pull uses checkpoints; stale snapshot rejected by the ledger |
| X-08 | Mismatch resolution: accept-ERP posts a ledger movement; keep-ours resolves with note |
| X-09 | Outbound: failure → retry/backoff → failed exception; retry after timeout never duplicates the ERP order |
| X-10 | Blocked connectors cannot be connected; discovery checklist recorded; secrets never stored/logged |
| X-11 | Tenant isolation + permissions for all integration data; OpenAPI coverage; E2E import → reimport → resolve |

---

## Results (2026-10-19) — status: implemented, awaiting review

### What was built
- **SDK** `packages/connector-sdk`: adapter contract, mapping engine, CSV/XLSX parsing (`read-excel-file`), deterministic simulator (6 documented change steps, order intake with injectable outages/timeouts) and `simulatorAdapter`.
- **Contracts**: connector registry + blocked dependencies, integration DTOs, 28 routes under `/v1/admin/integrations` (OpenAPI now 116 paths, CSV response support), new error codes.
- **DB** (migrations 0009 generated + 0010 RLS): connections, field_mappings, sync_jobs, sync_job_rows, external_records, sync_checkpoints, outbound_commands, connector_discovery; `stock_counts.connection_id`; `relayOutboundCommands` in `packages/db`.
- **API** `apps/api/src/modules/integrations`: connections/discovery/mappings/simulator/outbound (`connections.service.ts`), staging/commit/stock/reconciliation (`sync.service.ts`); ERP stock-ownership guard in Inventory.
- **Worker**: outbound order export loop every 5 s (`apps/worker/src/integration-jobs.ts`).
- **UI**: Integrations catalog (available vs blocked cards, discovery checklist, blocked-dependency tracker, connections), connection detail (overview/freshness, ownership matrix, import settings, sync upload/pull + simulator controls + CSV template, versioned mapping editor with preview, linked records, discrepancies with take-source/keep-ours, order export with simulated failures and retry), job preview/commit page with row filter and error CSV.
- **Seed**: `DEMO ERP (simulator)` connection for Aurum (nothing imported until someone pulls and commits).

### Commands and outcomes
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 0 errors / 0 warnings |
| `pnpm typecheck` | 0 | all 9 packages |
| `pnpm build` | 0 | all apps (3 new integration routes in the merchant admin) |
| `pnpm test` | 0 | **257 tests**: contracts 45, connector-sdk 8 (new), ui 2, db 25, api 168 (+13 integrations), worker 9 (+2) |
| `pnpm test:e2e` | 0 | **21 Playwright tests** (+2 integration flows) |
| `pnpm audit --audit-level high` | 0 | 0 high/critical; 4 moderate (new: `uuid` via `exceljs`, a test-only devDependency used to build XLSX fixtures) |
| `pnpm openapi:generate` | 0 | `docs/api/openapi.json` updated |

### Acceptance coverage (`apps/api/test/integration/integrations.spec.ts` unless noted)
| ID | Status | Evidence |
|---|---|---|
| X-01 initial import CSV + XLSX | PASS | preview writes nothing; commit creates 3 products + stock once (`erp_snapshot` movements); same data as XLSX → 3 unchanged; second commit refused |
| X-02 1000-record re-import | PASS | 1000 created → re-import 1000 unchanged → 2 changed rows update; variant count stays 1000 |
| X-03 out-of-order / malformed | PASS | older version → stale (stock unchanged); unknown location, fractional pcs, unknown unit, unknown purity, "5,1" weight, duplicate external ID → per-row errors; errors.csv download |
| X-04 deletions / partial | PASS | sold row → `erp_record_deleted` issue, product kept; atomic refused with errors, partial applies valid rows (savepoints) |
| X-05 SKU collision | PASS | collision with commerce product → error; "link existing by SKU" adopts the existing variant |
| X-06 field ownership | PASS | commerce-owned title not overwritten; manual adjustment on ERP-owned stock → 409 FIELD_OWNED_BY_ERP (API + E2E) |
| X-07 simulator / checkpoints / stale snapshot | PASS | 9 rows incl. 3 pieces (mg → g exact, received in stock), then per-step update/create/delete/stale; checkpoint "5"; older snapshot for the same connection → `rejected_stale` + issue |
| X-08 mismatch resolution | PASS | ownership change needs reason; reconcile finds 2 mismatches (deduped); take-source posts +2 ledger adjustment; keep-ours only resolves; viewer 403 |
| X-09 outbound | PASS | outage ×2 → retry → acknowledged; timeout after acceptance → same ERP order number (2 orders total); exhausted → failed + event, manual retry → acknowledged; replay 200 / changed lines 422 (API + `apps/worker/test/integration-jobs.spec.ts`) |
| X-10 honest tiers / secrets | PASS | vendor connectors blocked with blockers + fallback; connect refused 409; discovery checklist with optimistic locking; plain secret rejected, reference stored |
| X-11 isolation / permissions / E2E | PASS | other tenant 404 everywhere; viewer read-only; scoped operator denied; bad files FILE_FORMAT_INVALID; `e2e/tests/integrations.spec.ts` (blocked cards, discovery, CSV preview → partial apply → unchanged re-import → deletion flagged → keep-ours; simulator pull/advance/test order) |

### Defects found and fixed during this phase
1. ERP stale-snapshot protection was keyed per (location, source=erp), so two connections would block each other; snapshots now carry `connection_id` and the check is per connection (found while writing X-07, before any test ran).
2. `parseTimestamp("2026-02-30")` rolled over to 2 March instead of being rejected (caught by the SDK unit test).

### Known gaps / carried over
- Live vendor connectors, desktop agent, ERP media pull and signed inbound webhooks are blocked (see BLOCKED-DEPENDENCIES.md).
- ~~Committing 1,000 rows takes ~12 s~~ — fixed 2026-10-19, see "Pending-items review" below.
- Video media type for products is not added yet (no vendor exports media; manual upload is images only).
- ERP-acknowledged sale + next snapshot double-subtract protection needs real orders (Phase 07); the export pipeline it builds on is in place.
- Nothing from Phase 05 is committed.

## Pending-items review (2026-10-19, before starting Phase 06)

Re-run of all gates on the uncommitted Phase 05 tree first: format/lint/typecheck/build exit 0, 257 unit/integration
and 21 E2E tests pass.

| Item | Status | What it needs / where it goes |
|---|---|---|
| Large import commit speed | **Done now** | Measured 27 s for 1,000 new rows (18.8 s row loop + 8.7 s stock), so a 5,000-row file would have held one HTTP request for 2+ minutes. Now: external records prefetched once per job; brand-new designs created in multi-row statements inside a savepoint (any failure → that savepoint is rolled back and the rows go through the unchanged per-row path, which reports exact row errors); one `applied` update; `last_stock` written in one statement; piece receipts grouped per location; `postMovements` (shared ledger) creates, locks and updates balances set-based in chunks of 1,000 while keeping the global lock order. Result: ~4 s per 1,000 rows (X-02 test 31.5 s → 6.7 s). See ADR-020. |
| Live TallyPrime / Jwelly / Acme Infinity / Jewels Prime connectors | Blocked | Vendor docs, sandbox credentials, pilot merchant (BLOCKED-DEPENDENCIES.md). File import works meanwhile. |
| Desktop agent (on-premise Tally pull) | Blocked | A confirmed local-software pilot, then build + security review (Phase 11). |
| ERP media pull | Blocked | Vendors to confirm media export format. |
| Signed inbound webhooks | Deferred to Phase 11 | No vendor pushes events yet; Phase 11 builds the signed, idempotent webhook ingress. |
| Video media type on products | Not needed yet | No source supplies video; manual upload stays images-only until a vendor or merchant need exists. |
| ERP-acknowledged sale vs next snapshot (double-subtract) | Deferred to Phase 07 | Needs real orders; Phase 07 enqueues order export into the existing outbound pipeline and must net acknowledged-but-not-yet-in-snapshot sales. |
| Commit still synchronous | Acceptable now | ~20 s for the 5,000-row maximum. Moving commit to a background job is tracked for Phase 11 (operations hardening) if real files are bigger. |
