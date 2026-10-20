# Phase 09 — B2C: retail workflows — task plan

## Repo inspection summary (start of phase)
- Phases 01–08 committed locally (`1668f1e`, not pushed). 317 unit/integration + 30 E2E green.
- Already in place: storefront domain resolver (Host or `X-Storefront-Host` + gateway key), published catalog API,
  storefront pricing quotes, carts (token), checkout with authoritative re-price + acknowledgement + holds, sandbox
  PSP with HMAC-signed callbacks, order expiry, cancellation (releases holds/commitments, records refund due),
  B2B buyer portal pattern (Next.js app + server-side proxy).
- Missing for retail: consumer identity, a storefront web app, per-piece availability for shoppers, shipments,
  returns, refunds and customer communications. Inventory has holds → commitments → release but no "shipped" step:
  committed stock never leaves `on_hand`.
- Risks: a customer reading another customer's or tenant's orders (IDOR); refunds above what was captured
  (concurrency); refunds marked successful without a gateway result; stock double-counted after partial shipment
  and cancellation; a shipped piece sold again; consent changes not traceable; fake tracking/e-mail claims.

## Scope
- **Customers (merchant-owned identities)** — feature `customers`, permissions `customers.read/manage`.
  A storefront customer belongs to one tenant (not a platform user): own credential (argon2id), own session table
  and cookie `uc_c_sess` (12 h, HttpOnly, SameSite=Strict) on the storefront domain. Register, sign in/out,
  profile, saved addresses, communication preferences. Consent is an **append-only** log (channel, purpose,
  granted/withdrawn, source, time); the current state is derived from it. `/v1/storefront/account/*` requires
  the CSRF header and a same-domain Origin; sign-in throttled per IP and per email; lockout after repeated failures.
  E-mail verification and password reset need an e-mail connector (Phase 11) → shown as blocked, not faked.
- **Checkout linkage**: an order placed while signed in is linked to the customer (`orders.customer_id`); guest
  orders are not auto-linked by e-mail (the address is unverified).
- **Per-piece availability**: `GET /v1/storefront/catalog/products/{slug}/pieces` lists in-stock, active pieces of
  published variants with their actual weights so a shopper picks the exact piece; the cart quote prices it.
- **Fulfillment** (feature `fulfillment`, permission `fulfillment.manage`): shipments with lines (partial
  allowed) → `packed` → `shipped` (ledger movement `shipment`: on-hand −q and committed −q at the hold's location;
  piece → `shipped`; reservation `fulfilled_quantity` grows, status `fulfilled` when complete) → `delivered`.
  Packed shipments can be cancelled (no stock effect). Carrier and tracking number are typed by staff and labelled
  "manual — not tracked" (no courier API). Order `fulfillment_status` unfulfilled / partial / fulfilled.
- **Cancellation after partial shipment**: cancelling a whole order is refused once anything shipped (409
  ORDER_SHIPPED); "Cancel unshipped items" releases only the remaining committed quantity through the ledger and
  records the refund due for exactly the unshipped value (line totals split by quantity, no float).
- **Returns**: customer (account) or staff request lines/quantities from shipped items within the return window
  (`return_window_days`, configurable, default 14 — not legal advice) → staff approve / reject → receive with
  "restock" (ledger `return_receive`, piece back `in_stock`) or "do not restock" (piece `written_off`).
- **Refunds** (permission `payments.refund`): against a captured payment only; amount ≤ captured − already
  refunded (pending + succeeded), enforced under a row lock and by a DB check; sandbox gateway result arrives as a
  signed callback (same HMAC verification and replay protection); `payment_status` → partially_refunded /
  refunded; refund due decreases. No refund is ever shown as succeeded without the callback.
- **Customer communications**: transactional messages (order confirmed, shipped, delivered, return updates,
  refund) are recorded per order with status `not_sent` and the reason "no e-mail connector configured" until
  Phase 11; shown on the admin timeline and in the customer account. Marketing messages are not sent in this phase.
- **Storefront app** `apps/storefront` (port 3103, Next.js, same-origin proxy like the buyer portal): catalog with
  search/category filter, product page (variants, pieces with weights, server price build-up with rate time),
  cart (quote expiry shown), checkout (contact, address, acknowledgement of changed totals), sandbox payment,
  order status, account (sign-in/register, orders with shipments, request return, addresses, preferences).
- **Admin UI**: Customers (list/search, detail with profile, consent history, addresses, orders); order detail
  gains Fulfillment (create shipment from remaining quantities, ship, deliver, cancel), Cancel unshipped items,
  Returns (approve/reject/receive), Refunds (issue), Messages; Orders → Returns list; order settings gain the
  return window.

## Screens (route · user · precondition · DTO · permission)
| Route | User | Precondition | DTO | Permission |
|---|---|---|---|---|
| storefront `/` | shopper | B2C domain resolves | StorefrontProductPage | public |
| storefront `/products/[slug]` | shopper | product published | StorefrontProduct, StorefrontPieces, StorefrontQuote | public |
| storefront `/cart`, `/checkout` | shopper | cart token | Cart, CheckoutRequest, StorefrontOrder | public (token) |
| storefront `/orders/[id]` | shopper | cart token or own account | StorefrontOrder | token / customer session |
| storefront `/account/*` | customer | signed in | CustomerMe, CustomerOrder, ReturnRequest | customer session |
| admin `/customers`, `/customers/[id]` | staff | feature `customers` | CustomerSummary/Detail | customers.read |
| admin order detail → Fulfillment | staff | order confirmed | Shipment | fulfillment.manage |
| admin order detail → Refunds | staff | captured payment | Refund | payments.refund |
| admin `/orders/returns` | staff | feature `fulfillment` | ReturnSummary | orders.read (+ fulfillment.manage to act) |

## Acceptance cases
| ID | Case |
|---|---|
| C-01 | Customer register/sign-in/out; session bound to the tenant's storefront; staff/buyer sessions cannot use it and vice versa; CSRF enforced; throttling |
| C-02 | Customer sees only own orders/returns/addresses (other customer and other tenant → 404); admin customers isolated per tenant |
| C-03 | Consent log append-only; preferences reflect the latest event per channel/purpose |
| C-04 | Shopper picks an exact piece; checkout reserves that piece; a second checkout for it fails; price re-validated (QA B2C P0) |
| C-05 | Partial shipment posts `shipment` movements (on-hand and committed decrease by exactly the shipped quantity); piece becomes `shipped`; fulfillment status partial → fulfilled |
| C-06 | Whole-order cancel refused after shipment; cancel unshipped items releases only the remainder and records the exact refund due |
| C-07 | Return within window → approve → receive with restock (`return_receive`, piece in stock) or without (written off); outside window refused |
| C-08 | Refund ≤ captured − refunded; concurrent refunds cannot exceed; signed callback required; replay ignored; failed refund frees the amount |
| C-09 | Customer messages recorded as not sent (no connector) — never shown as delivered |
| C-10 | Storefront E2E: product → piece → cart → checkout → sandbox pay → account order history; staff ship, customer sees shipment |

## Not in scope / blocked
- Real PSP refunds and payouts (gateway account), courier labels/tracking (courier account), e-mail/SMS/WhatsApp
  delivery, e-mail verification and password reset (notification connector, Phase 11), invoices/credit notes
  (GST invoice format pending accountant validation), exchanges (return + new order instead), store credit.

## Results (2026-10-20) — status: implemented, awaiting review

### What was built
- **Contracts**: `dto/fulfillment.ts` (shipments, returns, refunds, customer messages), `dto/customers.ts` (admin
  customers, storefront account, consent, addresses, customer orders, storefront pieces); order DTOs gain
  `fulfillmentStatus`, per-line shipped/shippable/returned, customer, shipments, returns, refunds, messages;
  payments gain `refundedMinor`; payment status `partially_refunded`/`refunded`; movement types `shipment`,
  `return_receive`; reservation status `fulfilled`; piece state `shipped`; sandbox webhook `refundId`; 4 error
  codes; 27 routes; `IMPLEMENTED_PHASE = 9`, OpenAPI `1.0.0-phase09`. Viewer role no longer gets `customers.read`.
- **DB** (0017 generated + 0018 security): `customers, customer_sessions, customer_addresses, consent_events,
  shipments, shipment_lines, returns, return_lines, refunds, customer_messages`; RLS on all; consent log and
  shipment/return lines immutable; refund amount immutable (trigger); `payments_refunded_ck`;
  `reservations_fulfilled_ck`; tenant-safe `orders_customer_fk`; viewer roles synced. `packages/db/src/fulfillment.ts`
  (`dispatchStock`, `receiveReturnStock`), `messages.ts`; release/reconciliation/ERP add-back count only the
  unshipped remainder; whole-order cancel refused after shipment. Demo seed: `customer@lumiere.demo`.
- **API**: `modules/customers` (customer auth, account, admin customers), `modules/fulfillment` (shipments,
  cancel unshipped items, returns, refunds); refund settlement in the sandbox webhook; storefront pieces endpoint;
  checkout links signed-in customers; CSRF guard covers `/v1/storefront/account/*`.
- **Merchant admin**: order page Fulfillment / Returns / Refunds / Customer messages panels, Orders → Returns,
  return window setting, Customers list and detail (consent history, addresses, orders, disable).
- **Storefront** `apps/storefront` (port 3103, `pnpm dev:store`): catalog with search/category, product page with
  exact pieces and server price build-up (rate time), cart, checkout with price-change acknowledgement, sandbox
  payment, order status, register/sign-in, account (orders, preferences, addresses), order detail with shipments
  and return requests.

### Commands and outcomes
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 0 errors / 0 warnings |
| `pnpm typecheck` | 0 | all 11 packages (incl. storefront) |
| `pnpm build` | 0 | all apps (storefront: 11 routes) |
| `pnpm test` | 0 | **327 tests**: contracts 64, connector-sdk 8, ui 2, db 25, api 219 (+10 B2C), worker 9 |
| `pnpm test:e2e` | 0 | **31 Playwright tests** (+1 storefront → admin fulfilment → customer) |
| `pnpm audit --audit-level high` | 0 high/critical | 4 moderate (unchanged) |
| `pnpm openapi:generate` | 0 | `docs/api/openapi.json` updated |

### Acceptance coverage (`apps/api/test/integration/b2c.spec.ts`, `e2e/tests/storefront.spec.ts`)
| ID | Status | Evidence |
|---|---|---|
| C-01 accounts | PASS | register/me/logout/login; duplicate e-mail EMAIL_TAKEN; wrong password generic; missing CSRF and foreign Origin refused; session invalid on another store (401), on the B2B portal (404) and for admin APIs (401); staff session is not a customer session; same e-mail at another merchant is a separate account |
| C-02 isolation | PASS | other customer's order/address → 404; account order list only own orders (line count checked); other tenant's staff → 404; viewer → 403; disabling ends sessions; guest orders never linked |
| C-03 consent | PASS | latest event wins; unchanged preference adds no event; full history in admin; UPDATE/DELETE on consent_events rejected by DB |
| C-04 exact piece | PASS | pieces endpoint lists the piece with actual weights; signed-in checkout links the order; piece committed and no longer listed; second purchase fails; ships as `shipped` with a −1/−1 `shipment` movement |
| C-05 partial shipment | PASS | pack/unpack has no stock effect; over-pack refused; ship 2 of 3 → on-hand 5→3, committed 3→1, `partial`; rest → `fulfilled`; deliver; viewer cannot ship; no open reconciliation issues |
| C-06 cancel after shipment | PASS | cancel → ORDER_SHIPPED; cancel unshipped items releases 2 units, refund due exactly 1400 of 2100; repeat refused; refund settles due → `partially_refunded` |
| C-07 returns | PASS | none before shipment; over-quantity 422; customer request → approve (reject needs reason) → receive with restock (+1 on-hand, `return_receive` movement); not-restocked piece written off; window 0 days → RETURN_WINDOW_CLOSED |
| C-08 refunds | PASS | > captured → REFUND_EXCEEDS_CAPTURED; Idempotency-Key required; viewer 403; declined refund frees amount; two concurrent 600 on 1000 → one 201 / one 409; full → `refunded`; DB check blocks over-refund; forged signature 401; replay acknowledged as duplicate; unpaid order cannot be refunded |
| C-09 messages | PASS | confirmed/shipped messages recorded `not_sent` with reason, visible to staff and customer |
| C-10 storefront E2E | PASS | register → product → cart → checkout (prefilled) → sandbox pay → account; staff see customer, pack and ship; customer sees carrier/tracking and can request a return |

### Defects found by tests and fixed
1. Customer order count and account line count subqueries bound `id` to the inner table (always 0 / wrong) →
   explicit table names.
2. A refund's success double-counted itself when deciding `refunded` vs `partially_refunded` → fixed before tests.
3. A refund could be left pending forever if the sandbox gateway was disabled → refused up front.
4. Viewer role would have read customer personal data → `customers.read` removed from viewer (and existing roles).

### Known gaps / carried over
- Real PSP refunds, courier labels/tracking, e-mail/SMS delivery, e-mail verification and password reset, GST
  invoices/credit notes are blocked (see BLOCKED-DEPENDENCIES); exchanges are a return plus a new order; no store
  credit. Customer self-service account deletion/export (privacy requests) is not built yet → Phase 11/12.
- Discounts, CMS pages/themes, analytics → Phase 10.
