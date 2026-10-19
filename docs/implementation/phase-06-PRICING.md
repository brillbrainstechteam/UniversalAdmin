# Phase 06 — PRICING: metal rates and pricing — task plan

## Repo inspection summary (start of phase)
- Phases 01–04 approved and pushed (`5060d81`); Phase 05 implemented, gates re-run green, uncommitted; the user
  asked to advance through the remaining phases (2026-10-19). 257 unit/integration + 21 E2E green.
- Building blocks: purity definitions with fineness (Phase 03), design specs with billing basis and serialized
  pieces with actual gross/net/fine/stone and stone components, `decimal.js` measurement math, channels, outbox,
  audit, idempotency, maker-checker precedent (`jewellery.review`). Permissions `rates.*` / `pricing.*` and the
  `rate_editor` / `rate_approver` system roles already exist; nav entry "Pricing & Metal Rates" waits for phase 6.
- Decisions already taken: OD-1 money = integer minor units + currency, rates/weights NUMERIC(20,6); OD-2
  `decimal.js`; OD-4 lock at quote creation with TTL (default 15 min), revalidate at checkout; OD-7 tax = merchant
  entered rules flagged "pending accountant validation", no hardcoded GST; OD-8 manual rates only until a licensed
  provider + credentials exist.
- Risks: float drift, double-counting wastage/tax, presenting illustrative rates as live, stale rates silently
  used, self-approval of rates, ambiguous units (per 10 g vs per g), rule conflicts, quotes that change after
  being shown, prices leaking for unpublished products.

## Scope
### Rates (feature `metal_rates`)
- **Rate sources**: per-tenant `manual` source (always present); provider adapter contract (capabilities, licence
  reference, credential *reference*, markets, units) with a registry of honest tiers: `simulator` (deterministic,
  every value labelled SIMULATED, never "live") available; `licensed_feed` blocked on a licensed provider +
  credentials (BLOCKED-DEPENDENCIES).
- **Metal rates** are append-only proposals: metal + purity + currency + canonical rate per gram (input unit
  per g / per 10 g / per kg converted exactly; more precision than 6 dp is rejected), raw input kept,
  `source_as_of`, `effective_from`, reason (required for manual entries). Lifecycle proposed → approved | rejected;
  approval needs `rates.approve` and a different person than the proposer (DB CHECK + service). Value columns are
  immutable (trigger); "rollback" = propose the old value again. Events RateProposed / RateApproved /
  RatePublished; approval of an effective-now rate publishes it.
- **Current rate** = latest approved rate with `effective_from ≤ now` per metal + purity + currency.
- **Freshness**: rate is stale when `source_as_of` is older than the tenant's max age. Policy `block` (quotes fail
  with RATE_STALE) or `use_last_approved` (quote proceeds, flagged "stale rate" with provenance). Worker emits
  RateStale once per rate.
### Pricing (feature `pricing`, all presets)
- **Pricing settings**: quote TTL (default 15 min), rate max age, stale policy, rule review (maker-checker for
  rule publishing, default on).
- **Tax rules** (hook): label, percent, components it applies to, effective dates, validation status
  (`pending_validation` default; shown on every quote). Nothing is pre-filled.
- **Price books**: name, channel (or all), priority, currency, effective window, status; **list prices** per
  variant for standard (non-metal) pricing.
- **Price rules**: typed, versioned, non-executable JSON (zod): conditions (product type, categories, metals,
  purities) and a definition — base (`metal` by gross/net/fine/item basis, or `list_price`), making (per gram /
  per piece / % of metal / fixed / tiered per gram), wastage (% of billable weight, explicit basis), stones (per
  carat / per piece by kind and optional grade; missing rate = error), charges (hallmark, certificate, packing,
  labour, other: fixed / per piece / per gram), discount (% or fixed on chosen components, allocated
  proportionally), tax rule reference. Draft → published (supersedes previous published version of the same rule)
  → retired. Publishing detects conflicts (same book, same priority, overlapping conditions → 409 RULE_CONFLICT).
- **Engine** (`@uc/contracts/pricing-engine`, pure): exact decimals; each component computed for the whole line and
  rounded once to currency minor units half-up; discount allocated by largest remainder; tax = round(Σ taxable ×
  rate) once; total = Σ rounded parts. Every component returns its formula, inputs and exact intermediate value.
- **Precedence**: books matching the channel (channel-specific before all-channel), active and in window, by
  priority desc; within a book rules by priority desc; first matching rule wins; the breakdown names book + rule
  version.
- **Quotes**: server-calculated for variants (design spec weights / list price) or serialized pieces (actual
  weights); immutable breakdown with rate IDs, rule version IDs, tax rule, inputs; TTL; revalidate → unchanged /
  changed (new quote) / unavailable. Pieces under weight review, retired or written off cannot be quoted.
- **Storefront** `POST /v1/storefront/pricing-quotes`: only active + published products of that channel, per-IP
  rate limit, customer-facing breakdown with rate time and expiry.
- **Admin calculator**: price real items/variants, or ad-hoc measurements against a draft or published rule
  (nothing persisted).

## Screens
| Route | User | Precondition | API / DTO | Permission | States | Test |
|---|---|---|---|---|---|---|
| `/pricing` | rate editor/approver, owner | `pricing` feature | rates current, pending, sources | rates.read or pricing.read | loading, empty (no rates), stale badges, forbidden | E2E pricing.spec |
| `/pricing/rates` | rate editor / approver | `metal_rates` | GET/POST rates, approve, reject | rates.read / rates.edit / rates.approve | history filters, self-approval error | API PR-02, E2E |
| `/pricing/books` | pricing editor | pricing | price books CRUD | pricing.read / pricing.edit | empty, validation | API PR-05 |
| `/pricing/books/[bookId]` | pricing editor | book exists | rules list, list prices | pricing.read / edit | empty rules, conflict error | API, E2E |
| `/pricing/rules/[ruleId]` | editor / publisher | rule exists | rule versions, draft edit, publish, test calc | pricing.edit / pricing.publish | review state, conflict | API PR-06, E2E |
| `/pricing/calculator` | anyone with pricing.read | pricing | POST calculate | pricing.read | missing rate/stale errors, breakdown | E2E |
| `/pricing/quotes` + `/[quoteId]` | pricing reader | pricing | quotes list/detail/revalidate | pricing.read | expired badge | API PR-08 |
| `/pricing/settings` | owner/editor | pricing | settings, tax rules | pricing.read / pricing.edit | pending-validation banner | API |

## Acceptance cases
| ID | Case |
|---|---|
| PR-01 | Units: per 10 g and per kg convert exactly; over-precise / ambiguous input rejected; rate is per purity + currency |
| PR-02 | Maker-checker: proposer cannot approve (403 SEPARATION_OF_DUTIES); approver publishes; values immutable in DB; history kept; rollback by new revision |
| PR-03 | Stale policy: block → RATE_STALE; use_last_approved → quote flagged stale with provenance; RateStale emitted once |
| PR-04 | Fixture: gross-based and net-based rules give exact amounts (no float drift, e.g. 0.1+0.2 style cases) |
| PR-05 | Fixture: per-gram + per-piece making, tiered making, wastage, stones per carat/per piece, charges, % and fixed discount allocation, tax hook → explicit breakdown that sums exactly |
| PR-06 | Rule versions: publish supersedes, old quote keeps old version; conflict detection; review required (author ≠ publisher) |
| PR-07 | Book precedence: channel-specific beats all-channel; priority order; no matching rule → PRICE_RULE_MISSING |
| PR-08 | Quote TTL: expired quote reported; revalidate after a new rate → changed + new quote; old quote breakdown unchanged |
| PR-09 | Serialized pieces with different actual weights price differently; pending-review piece refused |
| PR-10 | General commerce: list price from price book, no metal rates needed |
| PR-11 | Storefront: only published products, customer breakdown, rate limited; tenant isolation & permissions for all pricing data |

## Not in scope / blocked
- Licensed live rate feed (blocked: licence + credentials). Simulator values are never shown as market data.
- Company-specific price books (Phase 08 adds companies and price-book assignments).
- Checkout reprice/acknowledgement and order snapshots (Phase 07 consumes quotes + revalidate).
- Tax correctness: rules are merchant data pending accountant validation; no GST rates shipped.

## Results (2026-10-19) — status: implemented, awaiting review

### What was built
- **Contracts**: `dto/pricing.ts` (rates, sources, settings, tax rules, books, list prices, versioned rule DSL, quotes,
  calculator, storefront quote, item search), `pricing-engine.ts` (pure exact engine, conditions/overlap,
  `ratePerGram`, largest-remainder allocation), `rate-providers.ts` (honest provider tiers + simulator values); 6 new
  error codes; 36 routes; `IMPLEMENTED_PHASE = 6`.
- **DB** (migration 0011 generated + 0012 security): `pricing_settings, rate_sources, metal_rates, tax_rules,
  price_books, price_list_entries, price_rules, price_rule_versions, price_quotes`, all with RLS. Triggers make rate
  values, published rule versions and quotes immutable; `metal_rates_four_eyes_ck` enforces approver ≠ proposer in
  the database; `DELETE` revoked from the runtime role on rates, rule versions and quotes. Provisioning creates the
  settings row and manual source; `flagStaleRates` for the worker.
- **API** `apps/api/src/modules/pricing`: `RatesService` (propose / approve / reject, sources, simulator pull,
  current rates with freshness), `PricingService` (settings, tax rules, books, list prices, rules with drafts,
  review, conflict detection under a per-book advisory lock, retire), `QuoteService` (item resolution for variants and
  pieces, book/rule precedence, freshness policy, immutable quotes, revalidate, calculator, item search, storefront
  quote), storefront endpoint with per-IP rate limit.
- **Worker**: rate staleness loop (every minute) emitting `RateStale` once per rate.
- **UI** (merchant admin → "Pricing & Metal Rates"): overview (current rates, freshness, approvals, books), metal
  rates (history, propose, approve/reject, sources and providers), price books (list, detail with rules and list
  prices), structured rule builder with versions, publish/retire and a test calculator, calculator (item/piece →
  explainable breakdown → save as quote), quotes list + detail with revalidation, settings & tax rules.
- **Seed**: DEMO rates (labelled "illustrative value, not a market rate") for 14K/18K/22K/24K approved by a second
  person (`rates@aurum.demo`, rate approver), a published gold rule, and Northwind GBP list prices + list-price rule.

### Commands and outcomes
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 0 errors / 0 warnings (pricing code added to the "no JS numbers" rule) |
| `pnpm typecheck` | 0 | all 9 packages |
| `pnpm build` | 0 | all apps (9 new pricing routes in the merchant admin) |
| `pnpm test` | 0 | **294 tests**: contracts 64 (+19 pricing fixtures), connector-sdk 8, ui 2, db 25, api 186 (+18 pricing), worker 9 |
| `pnpm test:e2e` | 0 | **25 Playwright tests** (+4 pricing flows) |
| `pnpm audit --audit-level high` | 0 | 0 high/critical; 4 moderate (unchanged) |
| `pnpm openapi:generate` | 0 | `docs/api/openapi.json` updated |

### Acceptance coverage (`apps/api/test/integration/pricing.spec.ts`; engine fixtures in `packages/contracts/test/pricing-engine.spec.ts`)
| ID | Status | Evidence |
|---|---|---|
| PR-01 units | PASS | 66600 per 10 g → 6660.000000 /g; over-precise per kg and zero rejected; other tenant's purity 404; JPY/INR exponents |
| PR-02 maker-checker | PASS | proposer approve → 403 SEPARATION_OF_DUTIES; editor without permission → PERMISSION_DENIED; approver publishes (RateApproved + RatePublished); DB trigger blocks value change; four-eyes CHECK blocks self-approval even for the owner role; runtime role cannot DELETE; rollback = new revision, one current |
| PR-03 freshness | PASS | stale + block → 409 RATE_STALE; use_last_approved → quote flagged stale; `flagStaleRates` emits RateStale once; simulator values labelled SIMULATED and still need approval; blocked licensed feed → CONNECTOR_UNAVAILABLE; plain secret rejected |
| PR-04 gross vs net | PASS | fixtures: gross 6868013 / net 6616744 minor; 1.005 g × 1.00 → 1.01 (no float drift); missing weight/rate/basis/currency errors |
| PR-05 breakdown | PASS | fixture with tiered making, wastage, per-carat stones (grade match), charges, 10% discount allocation, 3% tax → 18099490 and parts sum exactly; per-piece stones; % of metal; capped fixed discount; missing stone rate is an error |
| PR-06 versions & review | PASS | editor cannot publish; owner cannot publish own draft (review); approver publishes v2, v1 superseded; old quote keeps v1 and its total; published version immutable in DB; PriceRulePublished |
| PR-07 precedence | PASS | channel book beats all-channel; same-priority overlapping rule → 409 RULE_CONFLICT; book without a matching rule falls through; no rule → PRICE_RULE_MISSING |
| PR-08 TTL & revalidate | PASS | 15-min expiry; unchanged keeps the quote; new rate → changed + new quote, original unchanged (superseded); second revalidate 409; expired same price → re-issued; failing item → unavailable; quote row immutable |
| PR-09 pieces | PASS | AUR-T-0001 2979240 vs AUR-T-0002 2963115 minor (actual weights); design × 3; duplicate piece 422; piece under review refused |
| PR-10 general commerce | PASS | Northwind GBP list price × 2 = £19.00; metal rates FEATURE_NOT_ENTITLED; list price set/removed (missing → 422) |
| PR-11 storefront/isolation | PASS | Host-resolved quote, customer breakdown without internal IDs; unpublished and other-tenant items 404; 429 when rate limited; other tenant 404 on rates/quotes/rules/approve; viewer read-only (API + E2E) |

### Audit (protocol step 5)
- **Tenant scoping**: every table has `tenant_id` + RLS; composite `(tenant_id, id)` foreign keys for source, purity,
  channel, book, rule, variant; services filter by tenant explicitly; storefront resolves the tenant from the
  verified domain only.
- **Authorization**: each route has one permission (rates.read/edit/approve, pricing.read/edit/publish); feature gates
  `metal_rates` / `pricing`; maker-checker in service + DB CHECK; rule review configurable (default on).
- **Idempotency**: approvals/publishing are state transitions under row locks (repeat → 409). Creating a quote is not
  idempotent by design (each call is a new immutable record); Phase 07 checkout references quote IDs.
- **Decimals**: no JS numbers for money/weights (lint rule extended); NUMERIC(20,6) rates, BIGINT minor units;
  `price_quotes_total_ck` makes total = subtotal − discount + tax in the database.
- **Transitions & transactions**: rate proposed → approved/rejected once; rule draft → published → superseded/retired
  (trigger); publishing serialised per book with an advisory lock; revalidation prices inside a savepoint.
- **Rollback**: see `migrations/ROLLBACK.md` 0011/0012.

### Known gaps / carried over
- Licensed live rate feed blocked (licence + credentials); simulator only. No price cache exists, so publish events
  are emitted for future consumers rather than invalidating anything.
- Company-specific price books arrive with companies (Phase 08); category conditions are supported by the API, the
  builder shows them read-only (no category picker yet).
- Storefront quotes are stored; a retention/cleanup policy belongs to Phase 11 operations.
- Checkout reprice + buyer acknowledgement and order price snapshots: Phase 07 (uses quotes + revalidate).
