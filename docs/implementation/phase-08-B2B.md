# Phase 08 — B2B: wholesale workflows — task plan

## Repo inspection summary (start of phase)
- Phases 05–07 committed locally (`675a9e4`, not pushed). 307 unit/integration + 28 E2E green.
- Building blocks: price books/rules with precedence (book scope today: channel or all), immutable quotes, staff
  orders on account with approval threshold, quotations (send → accept → convert), holds/commit/release, outbox,
  storefront domain resolver with trusted-gateway host forwarding, sessions with audiences `merchant|platform`.
- No buyer identity exists. Users are global; sessions carry an audience and a separate cookie per audience.
- Risks: a buyer reaching another company/location/price book/order (IDOR), buyers placing orders beyond credit or
  beyond their own limit, MOQ/minimum value bypassed client-side, RFQ quotes accepted after expiry, reps seeing
  companies they are not assigned to, cookie-authenticated buyer mutations without CSRF protection.

## Scope
- **Buyer audience**: `buyer` sessions (cookie `uc_b_sess`, 12 h, CSRF header required on mutations). A buyer is a
  global user linked to one or more companies of a tenant (`company_buyers`); the tenant comes from the B2B
  storefront domain (never from the client). A buyer with several companies picks one (`X-Company-Id`).
- **Companies** (permission `companies.read/manage`, feature `b2b_companies`): name, code, GSTIN (format-checked,
  validity pending — not verified against any registry), status (active / on_hold / inactive), payment terms
  (prepaid / on account), credit limit, minimum order value, assigned sales rep, company price book, catalog
  restriction (all published products or chosen collections), accounting authority (commerce / ERP — ERP figures
  are displayed as "not synced" until an ERP adapter exists).
- **Company locations** (billing/shipping addresses) and **buyers** (role buyer / approver / admin, location scope,
  per-order limit; invited by link, the buyer sets a password in the portal).
- **Rep assignment**: members whose only customer-facing role is `sales_rep` see only their assigned companies,
  RFQs and company orders.
- **Pricing**: price books can be assigned to a company; company books win over channel and all-channel books. List
  prices carry an optional minimum quantity (MOQ, pieces).
- **Credit**: append-only credit ledger per company (order charge, order release, payment, advance, adjustment with
  reason). Exposure = Σ entries. An on-account order is refused when exposure + total > limit (409
  CREDIT_LIMIT_EXCEEDED); company on hold refuses orders. Payments/advances are recorded by staff (`companies.manage`).
- **Buyer ordering**: bulk entry by SKU (paste lines), server validation (company catalog, MOQ, minimum value),
  company pricing; orders above the buyer's own limit go to `awaiting_buyer_approval` (a company approver/admin
  approves, not the same buyer); then the merchant approval threshold (Phase 07) applies; holds throughout.
- **RFQ**: buyer submits lines + note → staff reply (messages) and create a quotation from it → buyer accepts all or
  some lines (partial acceptance) before expiry → order at the frozen price (credit + approvals apply). Declined /
  expired states; worker expires RFQs.
- **Buyer portal app** (`apps/buyer-portal`, port 3102): sign in, accept invitation, catalog with company prices,
  bulk order, orders, approvals, RFQs & quotations, account (company, locations, credit summary).
- **Admin UI**: Companies list/detail (profile, locations, buyers + invite link, credit ledger, RFQs), RFQ inbox.

## Acceptance cases
| ID | Case |
|---|---|
| B-01 | Buyer sign-in is separate from merchant/platform; buyer session cannot call admin APIs and vice versa; CSRF enforced |
| B-02 | Buyer sees only own company: other company's orders/RFQs/quotations/locations 404; location-scoped buyer limited to its locations |
| B-03 | Company price book precedence over channel/all books; company catalog restriction hides other products |
| B-04 | MOQ and minimum order value enforced server-side |
| B-05 | Credit: limit exceeded → 409; on hold → refused; payments/advances reduce exposure; cancel releases exposure; ledger append-only |
| B-06 | Buyer limit → company approver approves (not self); merchant threshold still applies afterwards |
| B-07 | RFQ → messages → quotation → partial acceptance → order at frozen price; expired cannot be accepted |
| B-08 | Sales rep sees only assigned companies/RFQs/orders |
| B-09 | Invitation: single-use token, expires, sets the buyer's password; GSTIN format validated |
| B-10 | Tenant isolation: a buyer of tenant A on tenant B's portal has no access |

## Not in scope / blocked
- GSTIN verification against the government registry, e-invoicing (blocked: accountant/legal + GSP access).
- ERP outstanding/credit import (needs a vendor adapter); shipments and partial fulfilment (Phase 09).
- Email delivery of invitations (no notification connector until Phase 11): the link is shown once to staff.

## Results (2026-10-20) — status: implemented, awaiting review

### What was built
- **Contracts** `dto/b2b.ts`: companies, locations, buyers, credit ledger/summary, RFQs (+ readable `items`),
  buyer-portal DTOs (context, catalog, bulk price, orders, decisions, RFQs, quotations with partial accept);
  `Audience` gains `buyer` (staff login still accepts only `merchant|platform`); list prices gain `minQuantity`;
  order status `awaiting_buyer_approval`; errors `CREDIT_LIMIT_EXCEEDED`, `MINIMUM_NOT_MET`, `COMPANY_ON_HOLD`;
  `IMPLEMENTED_PHASE = 8`, OpenAPI `1.0.0-phase08`.
- **DB** (0015 generated + 0016 security): `companies, company_locations, company_buyers, credit_entries, rfqs,
  rfq_messages`; company/location/buyer/RFQ references on orders and quotations; RFQ numbering in order settings.
  RLS on all new tables; credit ledger and RFQ messages append-only (triggers); FKs keep a company's orders inside
  the tenant. Demo seed: Shree Jewels (DEMO) with two locations, a location-scoped buyer with an order limit, a
  company approver, a ₹5,00,000 credit limit, ₹10,000 minimum order and its own contract price book.
- **API** `apps/api/src/modules/b2b`: `CompaniesService` (companies, locations, buyers + one-time invitation link,
  credit ledger, rep filter), `RfqsService` (inbox, messages, quote → sent quotation frozen until valid-until,
  decline), `BuyerService` (portal scope from the storefront domain, buyer sign-in, context with company switch,
  invitations, catalog, bulk pricing with company book + MOQ + minimum value, ordering with credit lock, buyer
  limit → company approval → merchant threshold, RFQs, quotations with partial acceptance). Buyer sessions use
  their own cookie (`uc_b_sess`); `/v1/storefront/b2b/*` requires the CSRF header and a same-domain Origin.
  Pricing: a company book wins over channel/all books, and company-assigned books are invisible to everyone else.
- **Worker**: RFQ expiry added to the order/quotation expiry loop.
- **Merchant admin**: Companies (list, create, detail with profile, locations, buyers + invite link, credit ledger
  with payments/advances/adjustments), RFQ inbox and RFQ detail (thread, quote, decline). Nav shows Companies.
- **Buyer portal** `apps/buyer-portal` (port 3102, `pnpm dev:portal`): sign in, accept invitation, home (credit,
  locations), catalog, quick order (paste SKU lines → server price build-up → place; PRICE_CHANGED shown for
  re-acknowledgement), orders + detail (approve/reject for approvers), approvals queue, RFQs (list, new, thread),
  quotations (accept all or some lines). A same-origin Node proxy adds the shopper's domain and the storefront
  gateway key server-side; the key never reaches the browser.

### Commands and outcomes
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 0 errors / 0 warnings |
| `pnpm typecheck` | 0 | all 10 packages (incl. buyer portal) |
| `pnpm build` | 0 | all apps (buyer portal: 13 routes) |
| `pnpm test` | 0 | **317 tests**: contracts 64, connector-sdk 8, ui 2, db 25, api 209 (+10 B2B), worker 9 |
| `pnpm test:e2e` | 0 | **30 Playwright tests** (+2 buyer portal / RFQ inbox) |
| `pnpm audit --audit-level high` | 0 high/critical | 4 moderate (unchanged) |
| `pnpm openapi:generate` | 0 | `docs/api/openapi.json` updated |

### Acceptance coverage (`apps/api/test/integration/b2b.spec.ts`, `e2e/tests/b2b.spec.ts`)
| ID | Status | Evidence |
|---|---|---|
| B-01 sessions | PASS | buyer login only on the B2B domain (B2C domain 404); staff cannot sign in as buyers (403); buyer cookie rejected by admin API (401); staff login refuses `audience: buyer`; CSRF header required; logout ends the session |
| B-02 own company | PASS | other company's orders/RFQs/company header → 404; buyer limited to Mumbai cannot order for Pune (400) and does not see Pune orders |
| B-03 company pricing | PASS | contract book price (making ₹350/g + hallmark) for Shree; catalog restriction to collections hides other products (catalog + price 422) — also shown in the portal E2E |
| B-04 MOQ / minimum | PASS | price shows a MINIMUM_NOT_MET problem for the MOQ and for the minimum order value; placing that quote → 422 MINIMUM_NOT_MET |
| B-05 credit | PASS | over available credit → 409 CREDIT_LIMIT_EXCEEDED; payment frees credit; on hold → COMPANY_ON_HOLD; cancel → `order_release` entry; ledger append-only (DB) |
| B-06 buyer approval | PASS | over buyer limit → `awaiting_buyer_approval`; buyer cannot approve; approver confirms; with a merchant threshold set, company approval moves the order to `awaiting_approval` and staff confirm it; approver's own order → SEPARATION_OF_DUTIES (approve and reject) |
| B-07 RFQ | PASS | RFQ → staff/buyer messages → quotation → accept one of two lines at the frozen price after a price change; RFQ becomes accepted; expired quotation → QUOTE_EXPIRED (API + E2E thread) |
| B-08 sales rep | PASS | rep sees only assigned companies and their RFQs; unassigned → 404 |
| B-09 invitations | PASS | invalid GSTIN 400; preview → accept sets password; token single use |
| B-10 isolation | PASS | other tenants cannot reach companies; a buyer of another company sees nothing of Shree |

### Defects found by tests and fixed
1. A DTO name clash (`CreateLocationRequest` already used by inventory locations) → `CreateCompanyLocationRequest`.
2. The empty approvals queue renders an empty state, not a table (E2E assertion corrected; behaviour is intended).
3. The portal showed the API's raw ISO price-hold time → formatted locally from `expiresAt`.
4. Review of the acceptance table found the B-06 merchant-threshold path untested → test added (passes).

### Known gaps / carried over
- GSTIN is format-checked only (no registry verification); e-invoicing blocked (accountant/GSP).
- ERP-authoritative credit (`accounting_authority = erp`) shows figures as not synced until an ERP adapter exists.
- Invitations are not emailed (no notification connector until Phase 11); staff copy the one-time link.
- The admin and portal proxies make the API see the proxy's IP, so per-IP sign-in throttling counts all portal users
  together behind one proxy; per-email throttling still applies. Forwarded-IP trust needs a deployment decision
  (Phase 12).
- Shipments/partial fulfilment of company orders → Phase 09.
