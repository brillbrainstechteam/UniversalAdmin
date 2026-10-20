# Phase 10 — CMS & growth: online store, discounts, marketing and reports — task plan

## Repo inspection summary (start of phase)
- Phases 01–09 committed locally (`2a6a327`, not pushed). 327 unit/integration + 31 E2E green.
- Already in place: channels with theme tokens (edited directly, no versions/preview), channel domains (seeded, no
  add/verify flow), storefront resolver, B2C storefront app, customers with an append-only consent log, orders with
  frozen price snapshots (subtotal/discount/tax/total), pricing engine with rule-level discounts allocated before tax.
- Features/permissions already declared for this phase: `online_store` (`content.manage`), `marketing`
  (`marketing.manage`), `discounts` (`discounts.manage`), `analytics` (`analytics.read`).
- Risks: unpublished content leaking to shoppers; preview links usable forever or across tenants; a domain claimed
  without proof of control; discounts applied after tax (wrong tax), exceeding usage limits under concurrency,
  stacked when they must not be, or controlled by the browser; marketing sent to people without consent;
  report numbers without definitions or freshness; invented acquisition costs.

## Scope
- **Online store** (`content.manage`, feature `online_store`), per storefront channel:
  - *Site documents* with draft → publish and immutable versions: theme (tokens), header/footer menus, pages
    (slug, title, SEO, typed blocks: heading, text, image, product list, call-to-action), announcement banner (with
    optional schedule). Publishing snapshots a version; rollback = publishing an old version again (new version).
    Publishing the theme updates the channel theme the storefront reads.
  - *Preview*: staff mint a short-lived signed preview token (15 min, HMAC, bound to tenant + channel); the
    storefront shows drafts only with a valid token. Published content is all shoppers ever see otherwise.
  - *Redirects* (from path → to path, 301/302) resolved by the storefront.
  - *Domains*: add a custom domain → `pending` with a verification token; verify by DNS TXT record
    `_uc-verify.<host>` (real DNS lookup). `*.localhost` / `*.test` hosts may be verified in non-production only
    (labelled development verification). Only verified domains resolve.
- **Discounts** (`discounts.manage`): percentage or fixed order discounts, automatic or by code; minimum subtotal;
  validity window; total usage limit; per-customer limit; optional customer segment; channel restriction;
  combinable flag. Applied **before tax**: the order discount is split across lines (largest remainder) and each
  line's components, then tax is recomputed — the price snapshot shows the promotion. Server-side only: the cart
  stores a code, every quote and checkout re-evaluates eligibility; redemption is recorded with the order under a
  lock on the discount (limits cannot be exceeded concurrently). Combination: all eligible promotions apply only
  if every one is combinable; otherwise the single largest applies.
- **Segments & campaigns** (`marketing.manage`): segments are typed rules over customers (min orders, min spend,
  ordered within N days, registered within N days, consent for a channel); live count + members. Campaigns
  (e-mail/SMS/WhatsApp) target a segment; "prepare" snapshots recipients — only customers whose latest consent for
  that channel is granted; excluded counts are shown. Sending is **blocked** (no notification connector, Phase 11):
  recipients stay `not_sent`. Automation contracts (abandoned checkout etc.) are deferred to Phase 11 automations.
- **Attribution**: storefront checkout accepts UTM source/medium/campaign and landing path (stored on the order).
- **Reports** (`analytics.read`, feature `analytics`): registry of report definitions with metric formulas, filters
  (date range in tenant timezone, channel, location where relevant) and CSV export; every response carries
  `generatedAt` and data source. Reports: sales (orders, gross, discounts, refunds, net by day), metal weight sold
  (net grams by metal/purity from frozen snapshots), stock age (serialized pieces by days since receipt; other stock
  by days since last receipt — stated assumption), ERP order sync (export command status), conversion (carts →
  orders; no traffic data, so no visit conversion), channel & fulfilment, attribution (orders/revenue by UTM
  source). No CAC/ROAS: there is no ad-spend input.

## Acceptance cases
| ID | Case |
|---|---|
| G-01 | Draft content is invisible to shoppers; publish creates an immutable version; rollback republishes an old version |
| G-02 | Preview token shows drafts only for its tenant/channel, expires, forged token rejected |
| G-03 | Custom domain stays unresolved until verified; DNS verification failure is reported; localhost dev verification refused in production config |
| G-04 | Discount eligibility: dates, minimum subtotal, channel, segment, per-customer and total limits; inactive/expired code refused with reason |
| G-05 | Discount applied pre-tax with exact allocation; totals = subtotal − discount + tax; snapshot shows the promotion |
| G-06 | Combination rules: non-combinable → only the larger applies; combinable → both |
| G-07 | Concurrent checkouts cannot exceed a usage limit; redemption recorded once per order; browser cannot set the discount |
| G-08 | Segments evaluate correctly; campaign recipients include only customers with granted consent for the channel; nothing is marked sent |
| G-09 | Reports return defined metrics matching fixture orders (sales, grams, conversion, attribution), with generatedAt; CSV export; permission and tenant isolation |
| G-10 | E2E: publish a page + banner and see it on the storefront; create a code discount and use it at checkout; view a report |

## Not in scope / blocked
- E-mail/SMS/WhatsApp sending and approved templates (notification connector), ad-spend import for CAC/ROAS,
  marketplace/POS adapters, automations (Phase 11), TLS certificates for custom domains (hosting decision, Phase 12).

## Results (2026-10-20) — status: implemented, awaiting review

### What was built
- **Contracts**: `dto/growth.ts` (typed content blocks/menus/banner/theme, site documents, preview tokens, redirects,
  domains, segments, campaigns, discounts, applied promotions, attribution, report catalogue `REPORTS` with formulas);
  pricing engine `planPromotions` + per-line `promotions` applied before tax; carts expose `promotions`; checkout
  accepts `attribution`; orders expose `attribution` and `promotions`; 2 error codes; 32 routes;
  `IMPLEMENTED_PHASE = 10`, OpenAPI `1.0.0-phase10`.
- **DB** (0019 generated + 0020 security): `site_documents, site_document_versions, redirects, segments, discounts,
  discount_redemptions, campaigns, campaign_recipients`; `carts.discount_code`, `orders.attribution`, domain
  verification columns. RLS on all; versions and redemptions append-only; discount checks (value, window, code
  format, usage ≤ limit).
- **API**: `online-store` (documents, publish/rollback/unpublish, preview tokens, redirects, DNS domain
  verification, storefront site/pages/redirects), `discounts` (admin + `PromotionsService` evaluation/redemption),
  `marketing` (segments, members, campaigns, prepare), `reports` (7 reports, CSV). Checkout re-evaluates promotions
  with discount rows locked; cart endpoint for codes; config `PREVIEW_TOKEN_SECRET` (development default refused in
  production).
- **Merchant admin**: Online Store (content list, preview link, domains with DNS record, redirects; editors for
  theme, menus, banner and page blocks with versions/restore), Discounts, Marketing (segments, campaigns, prepare
  audience), Analytics (reports, filters, formulas, CSV).
- **Storefront**: published theme, header/footer menus, scheduled banner, content pages (blocks incl. collection
  products), draft preview via `?preview=`, redirects for unknown paths, discount code in the cart with the reason it
  does not apply, UTM attribution sent at checkout.

### Commands and outcomes
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | clean (3 files reformatted after the first run) |
| `pnpm lint` | 0 | 0 errors / 0 warnings |
| `pnpm typecheck` | 0 | all 11 packages |
| `pnpm build` | 0 | all apps |
| `pnpm test` | 0 | **341 tests**: contracts 66 (+2 promotion fixtures), connector-sdk 8, ui 2, db 25, api 231 (+12 growth, +1 config), worker 9 |
| `pnpm test:e2e` | 0 | **32 Playwright tests** (+1 page/banner/code/report flow) |
| `pnpm audit --audit-level high` | 0 high/critical | 4 moderate (unchanged) |
| `pnpm openapi:generate` | 0 | `docs/api/openapi.json` updated |

Note: in one of three full API runs the Phase 07 test O-06 failed once (its Lumière checkout did not return an
order); it passed alone, with the Phase 10 suites, and in the two following full runs. The test now asserts the
checkout response so a recurrence shows the cause. Recorded as an open flaky test, not hidden.

### Acceptance coverage (`apps/api/test/integration/growth.spec.ts`, `packages/contracts/test/pricing-engine.spec.ts`, `e2e/tests/growth.spec.ts`)
| ID | Status | Evidence |
|---|---|---|
| G-01 content | PASS | draft page 404 on storefront; publish → v1 served; new draft invisible; v2; restore v1 → v3 = v1 content; versions immutable (DB); unpublish → 404; unsafe `javascript:` link refused; viewer 403; other tenant 404; theme publish reaches `/config`; scheduled banner hidden until start |
| G-02 preview | PASS | own token shows drafts (`preview: true`); forged signature and another store's token see only published content |
| G-03 domains | PASS | pending domain does not resolve; development verification for `.test` then resolves; DNS failure → 422 DOMAIN_NOT_VERIFIED with reason; duplicate host (same or other tenant) 409; redirects resolve, loops/chains refused, removal works |
| G-04 eligibility | PASS | minimum spend, not started, expired, disabled, other channel, other currency, guest on customer-only code, unknown code — each with its reason; per-customer limit; segment-only code |
| G-05 pre-tax | PASS | engine fixtures (exact split across lines and components, VAT on discounted base); order subtotal − discount + tax = total; snapshot carries the promotion |
| G-06 combination | PASS | non-combinable: larger of auto 5% vs £4 code applies, smaller code explained; combinable: both |
| G-07 limits | PASS | two concurrent checkouts on a 1-use code → 201 + 409 PRICE_CHANGED; used_count 1, one redemption; redemptions append-only; used code terms locked; browser-acknowledged lower total refused |
| G-08 audiences | PASS | segment members include both customers; prepared recipients only the e-mail-consented one; counts add up; all `not_sent`; prepared campaign locked; e-mail campaign needs subject; isolation + viewer 403 |
| G-09 reports | PASS | sales totals equal an independent SQL query for the same window/time zone; conversion carts equal SQL; attribution row for a tagged order; CSV header with `_minor` money columns and formula-injection guard; all 7 reports run; other tenant does not see the row; bad dates/key 400 |
| G-10 E2E | PASS | page + banner published in the admin and seen on the storefront; code applied in the cart (−£0.95 → £8.55) and paid; attribution report shows the UTM source with the CAC note |

### Defects found by tests and fixed
1. Stock-age report used a non-existent ledger column (`created_at` → `occurred_at`).
2. The page editor stayed "unsaved" after saving (cache key missing the query part) — publish was blocked.
3. Page text blocks had an ambiguous accessible name (label wrapping the textarea) → explicit name.
4. Attribution kept an untagged first page and lost a later UTM-tagged arrival → latest tagged visit wins.
5. The storefront cart repeated the API's raw ISO price-hold note → hidden (the formatted one remains).
6. The new production-secret check pre-empted the existing sandbox check in config validation → reordered, tested.

### Known gaps / carried over
- Sending campaigns, approved templates and automations (Phase 11); ad-spend import (no CAC/ROAS); TLS for custom
  domains (Phase 12); per-product/collection discounts and buy-X-get-Y (order-level discounts only).
- Flaky O-06 observation above.
