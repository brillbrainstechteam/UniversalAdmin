# Phase 07 — ORDERS: orders, quotations, checkout — task plan

## Repo inspection summary (start of phase)
- Phase 06 implemented (uncommitted; user asked to keep advancing): rates with maker-checker, rule engine, immutable
  price quotes with TTL + revalidate, storefront price quotes. 294 unit/integration + 25 E2E green.
- Building blocks: inventory holds (`reserveStock` with per-variant locks, TTL, piece holds), commit/release,
  expiry worker; outbound order pipeline (`outbound_commands`, relay with stable references); storefront domain
  resolver; idempotency service; outbox/events (`OrderConfirmed|Cancelled`, `OrderExport*`, `Payment*`, `Quote*`).
- No storefront web app exists yet (headless API; branded storefronts come with Phase 10), no customers (Phase 09)
  or companies (Phase 08). Checkout therefore takes a contact + address on the order (guest checkout).
- Risks: browser-controlled totals, double charge / double order on retries, overselling the last piece under
  concurrency, holds expiring between payment and confirmation, forged payment callbacks, old orders changing when
  rates change, ERP double-subtracting an exported sale (carried from Phase 05).

## Scope
- **Order settings**: approval threshold (admin orders at/above need a second person), checkout hold minutes
  (payment window), quotation max validity days, number prefixes.
- **Carts** (storefront): created per channel with a secret token (hash stored); lines = variant (+ exact piece) +
  quantity; pricing via the Phase 06 storefront quote.
- **Checkout** (storefront, `Idempotency-Key` required): the client sends the quote it saw and acknowledges its total;
  the server re-prices — changed price → 409 PRICE_CHANGED with the new quote to acknowledge; then holds every line
  (all-or-nothing, checkout TTL), creates the order (`pending_payment`) with an immutable per-line price snapshot,
  and a **sandbox** payment. Same key → same order.
- **Sandbox payment gateway** (clearly labelled, disabled in production): a simulated PSP signs callbacks with HMAC;
  the public webhook verifies the signature (timing-safe), dedupes event IDs, and drives payment + order state.
  Success → commit holds → order `confirmed`; an expired hold is re-reserved, and if the stock is gone the order goes
  `on_hold` (paid, needs staff) instead of overselling. Failure → payment failed, order stays payable until expiry.
- **Admin orders**: draft order for a channel + contact + lines (priced server-side), submit → holds → `confirmed`, or
  `awaiting_approval` at/above the threshold (approver ≠ creator, approve commits / reject cancels).
- **Cancellation compensation**: release held or committed stock (ledger entries with reason), payment captured →
  refund due recorded (refunds are Phase 09), events + timeline.
- **Order export**: on confirmation, connections with `pushOrders` capability and `exportOrders` enabled get an
  outbound command `ORDER:<number>` (stable reference → no duplicate ERP order).
- **ERP double-subtract fix**: an ERP stock snapshot adds back quantities committed to orders that this connection
  already acknowledged, so the same sale is not subtracted twice.
- **Sales quotations** (admin): draft → sent (price frozen as a price quote valid until the chosen date) → accepted →
  converted to an order at the frozen price (stock is held at conversion) | cancelled | expired (worker).
- **Worker**: expire unpaid orders (cancel + release), expire quotations.
- **Admin UI**: orders list (filters, pagination), order detail (lines with measurements + snapshot, totals, payments,
  timeline, actions), new order, quotations list/detail/new, order settings.

## Screens
| Route | User | Precondition | API | Permission | States | Test |
|---|---|---|---|---|---|---|
| `/orders` | staff | `orders` feature | GET orders | orders.read | empty, filters, forbidden | E2E orders.spec |
| `/orders/[id]` | staff | order exists | GET order, cancel, approve, reject | orders.read / manage / approve | timeline, exceptions, SoD error | API O-05..O-08, E2E |
| `/orders/new` | sales staff | channel + priced items | POST orders | orders.manage | price errors, approval notice | E2E |
| `/orders/quotations` (+ `/[id]`, `/new`) | sales staff | `orders` | quotations CRUD + send/accept/convert | orders.read / manage | expired, converted | API O-09 |
| `/orders/settings` | owner | — | GET/PUT order settings | orders.read / orders.approve | — | API |

## Acceptance cases
| ID | Case |
|---|---|
| O-01 | Cart: token required; other tenant/channel items rejected; lines replace; storefront hides unpublished |
| O-02 | Checkout reprice: stale client quote with a different total → 409 PRICE_CHANGED + new quote; client cannot set the total; idempotent replay returns the same order |
| O-03 | Two concurrent checkouts for the last piece → exactly one order; the other 409 INSUFFICIENT_STOCK, nothing held |
| O-04 | Sandbox payment: forged signature 401; duplicate event processed once; success commits stock and confirms; failure keeps order payable; production refuses sandbox |
| O-05 | Expiry: unpaid order past its window is cancelled and its holds released by the worker |
| O-06 | Immutable snapshot: a new approved rate after confirmation does not change the order; order lines cannot be updated |
| O-07 | Admin order + approval: at/above threshold → awaiting approval; creator cannot approve; approver confirms; reject cancels and releases |
| O-08 | Cancellation compensation: committed stock released with ledger entries; paid order records refund due; events |
| O-09 | Quotation: send freezes price; accept + convert honours frozen price after a rate change; expired quotation cannot be accepted |
| O-10 | Order export: confirmed order queues one `ORDER:<number>` command per enabled connection; ERP snapshot after acknowledgement does not double-subtract |
| O-11 | Isolation and permissions on every order/quotation/payment resource |

## Not in scope / blocked
- Real payment gateway (blocked: gateway account + sandbox keys; BLOCKED-DEPENDENCIES). Refund execution, shipments,
  returns: Phase 09. Customer accounts: Phase 09. Companies, buyer portal, RFQ by buyers, credit: Phase 08.
- Invoices: commerce issues no tax invoices (OD-5); order documents are reference/proforma only (Phase 09/12).

## Results (2026-10-19) — status: implemented, awaiting review

### What was built
- **Contracts** `dto/orders.ts`: settings, orders (summary/detail with frozen line snapshots, holds, payments,
  timeline, ERP exports), carts, checkout, storefront order, sandbox payment + webhook, quotations; 3 new error codes;
  23 routes; `IMPLEMENTED_PHASE = 7`; storefront product variants now expose `id` (needed to fill a cart);
  connection setting `exportOrders` (default off); sync `stockResult.addedBack`.
- **DB** (0013 generated + 0014 security): `order_settings, carts, orders, order_lines, order_events, payments,
  payment_events, quotations`. RLS on all tenant tables; order lines immutable except re-pointing their stock hold
  (column grant + trigger); timeline append-only with an identity `seq`; order totals/identity immutable and a
  cancelled order cannot reopen (trigger); `orders_total_ck`; checkout idempotency key unique per tenant;
  `payment_events` for callback replay protection. Shared state machine in `packages/db/src/orders.ts`
  (`confirmOrder`, `cancelOrder`, `queueOrderExports`, `expireOrders`, `expireQuotations`,
  `acknowledgedCommitments`).
- **API** `apps/api/src/modules/orders`: `OrdersService` (list/detail/create/approve/reject/cancel/settings),
  `CheckoutService` (carts, checkout with authoritative re-price, storefront order view, sandbox pay),
  `PaymentsService` (sandbox PSP: HMAC-signed callbacks, timing-safe verification, event dedupe, late capture →
  refund due), `QuotationsService`; storefront endpoints rate limited per IP; config `PAYMENTS_SANDBOX_*`
  (refused in production) and env-configurable login throttling (defaults unchanged).
- **ERP**: confirmed orders queue `ORDER:<number>` exports to connections with `exportOrders`; ERP snapshots and
  reconciliation add back units committed to orders the ERP already acknowledged (carried Phase 05 P0).
- **Worker**: order/quotation expiry loop (30 s).
- **UI**: Orders (list with filters, detail with approve/reject/cancel, frozen breakdowns, payments, ERP export,
  timeline), New order, Quotations (list/new/detail with send/accept/convert/cancel), Order settings; connection
  setting "Send confirmed orders"; the pricing nav/title reads "Pricing" for merchants without metal rates.

### Commands and outcomes
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 0 errors / 0 warnings |
| `pnpm typecheck` | 0 | all 9 packages |
| `pnpm build` | 0 | all apps |
| `pnpm test` | 0 | **307 tests**: contracts 64, connector-sdk 8, ui 2, db 25, api 199 (+13 orders, +1 config), worker 9 |
| `pnpm test:e2e` | 0 | **28 Playwright tests** (+3 order flows) |
| `pnpm audit --audit-level high` | 0 | 0 high/critical; 4 moderate (unchanged) |
| `pnpm openapi:generate` | 0 | `docs/api/openapi.json` updated |

### Acceptance coverage (`apps/api/test/integration/orders.spec.ts`, `e2e/tests/orders.spec.ts`)
| ID | Status | Evidence |
|---|---|---|
| O-01 cart | PASS | token required (missing/wrong → 404), other storefront 404, other tenant's and unpublished items 404, server price on every change |
| O-02 checkout reprice | PASS | wrong acknowledgement 422; price change → 409 PRICE_CHANGED with new quote, nothing held; acknowledged → order; same key replays the same order; missing key 400; converted cart 409 |
| O-03 race | PASS | two concurrent checkouts for the last unit and for the same piece → exactly one 201 / one 409 INSUFFICIENT_STOCK |
| O-04 sandbox payment | PASS | forged signature 401; decline keeps order payable; success confirms + commits; duplicate event ignored; amount mismatch 422; disabled → PAYMENTS_DISABLED; production config refuses sandbox (unit) |
| O-05 expiry | PASS | unpaid order past window cancelled by the worker pass, hold released; late capture → refund due |
| O-06 snapshot | PASS | new approved rate after confirmation leaves total, rate and breakdown unchanged; DB rejects line/total updates |
| O-07 approval | PASS | threshold → awaiting approval with holds; creator cannot approve; second person confirms; reject cancels and releases; below threshold confirms at once; Idempotency-Key required (API + E2E) |
| O-08 compensation | PASS | cancel paid order → commitment released through the ledger, refund due recorded, cannot cancel twice, cancelled cannot reopen (DB) |
| O-09 quotations | PASS | max validity enforced; send freezes; convert after a price change uses the frozen total; expired cannot be accepted; worker expires (API + E2E) |
| O-10 export / no double subtract | PASS | one `ORDER:<n>` command per enabled connection, acknowledged by the simulator; snapshot ERP 4 + 1 acknowledged = 5 on hand, committed stays 1, reconciliation 0 mismatches |
| O-11 isolation | PASS | other tenant 404 on orders/quotations/cancel; viewer reads but cannot create/cancel/change settings |

### Defects found by tests and fixed
1. Timeline events written in the same transaction shared a timestamp and sorted randomly → identity `seq` column.
2. Cancelling an order failed its in-flight payment, so a late PSP capture would have been ignored → pending payments
   stay open and a late capture records a refund due.
3. Storefront products did not expose variant IDs, so no real storefront could fill a cart → `variants[].id`.
4. The E2E suite exceeded the per-IP sign-in limit → limits configurable by env (raised only for E2E).

### Known gaps / carried over
- Real payment gateway blocked (account + sandbox keys); refunds, shipments, returns → Phase 09; buyer accounts,
  companies, buyer-side RFQ and credit → Phase 08; customer accounts → Phase 09.
- ERP order cancellation is not sent to the ERP (warning on the order: cancel it there too).
- Storefront web app does not exist yet (headless API; storefront apps come with Phase 10).
