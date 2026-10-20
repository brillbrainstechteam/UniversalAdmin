# Development runbook

## Prerequisites
Node 22+, pnpm 9, Docker Desktop. Google Chrome (E2E uses the installed Chrome; CI downloads Chromium).

## First run
```bash
cp .env.example .env          # local placeholders only — never real secrets
pnpm install
pnpm infra:up                 # Postgres :5440, Redis :6390, S3-compatible object store :9010
pnpm build                    # builds packages and apps
pnpm db:reset                 # drop + migrate + seed demo data into uc_dev (non-production only)
```

Run the stack (separate terminals):
```bash
pnpm dev:api        # http://localhost:4100  (Swagger UI /docs, spec /v1/openapi.json, /health/ready)
pnpm dev:worker     # outbox relay → BullMQ + domain-event consumers
pnpm dev:merchant   # http://localhost:3100
pnpm dev:platform   # http://localhost:3101
```

## Demo accounts (seeded, `is_demo`, password = `SEED_DEMO_PASSWORD`, default `DemoPass!2026`)
| Email | App | Access |
|---|---|---|
| platform@uc.local | platform admin | platform owner |
| support@uc.local | platform admin | platform support (read-only) |
| owner@aurum.demo | merchant admin | Aurum Wholesale (B2B jewellery) — owner |
| viewer@aurum.demo | merchant admin | Aurum — viewer (read-only; demonstrates permission denial) |
| stock@aurum.demo | merchant admin | Aurum — inventory operator scoped to Mumbai branch |
| rates@aurum.demo | merchant admin | Aurum — rate approver (approves rates proposed by others; publishes price rules) |
| owner@lumiere.demo | merchant admin | Lumière Fine (B2C jewellery) — owner |
| owner@northwind.demo | merchant admin | Northwind General (general commerce, no jewellery) — owner |
| multi@demo.local | merchant admin | Aurum catalog editor + Northwind admin (tenant picker) |
| buyer@shree.demo | buyer portal | Shree Jewels (DEMO), Aurum's wholesale customer — buyer for the Mumbai location, order limit ₹1,00,000 |
| customer@lumiere.demo | storefront | Lumière (DEMO) storefront customer with a saved address (e-mail marketing opted in) |
| approver@shree.demo | buyer portal | Shree Jewels (DEMO) — company approver (approves buyers' orders above their limit) |

Each demo tenant has a small published demo catalog (products marked "Demo product" in their description).

Storefront catalog demo: `curl -H "Host: northwind.localhost" http://localhost:4100/v1/storefront/catalog/products`

Storefront resolver demo: `curl -H "Host: lumiere.localhost" http://localhost:4100/v1/storefront/config`
(`pending-aurum.localhost` is seeded unverified and must return 404).

## Quality gates (same as CI)
```bash
pnpm format:check && pnpm lint && pnpm typecheck
pnpm test          # unit + migration + integration (resets the uc_test database)
pnpm test:e2e      # Playwright; requires `pnpm build`; starts the API, both admins, the buyer portal and the storefront itself
pnpm openapi:generate   # regenerate docs/api/openapi.json after API contract changes
```
Tests never touch `uc_dev`. Redis logical DBs: 0 dev, 1 API tests, 2 worker tests, 3 E2E. S3 buckets: uc-dev-media, uc-test-media, uc-e2e-media.

## Database
- Migrations: `packages/db/migrations` (forward-only; rollback notes in `ROLLBACK.md`). Generate with
  `pnpm --filter @uc/db generate` after editing `packages/db/src/schema.ts`; the drift test fails if you forget.
- Runtime role `uc_app` is subject to RLS; migrations run as `uc_owner`. Tenant data access must go through
  `DbService.tenant()`; `DbService.system()` is reserved for platform/auth/resolver/worker paths.

## Ports
5440 Postgres · 6390 Redis · 9010 object store · 4100 API · 3100 merchant admin · 3101 platform admin · 3102 buyer portal · 3103 B2C storefront.

## Pricing demo (Phase 06)
Aurum and Lumière have DEMO metal rates (illustrative, not market data) approved by a second person, and a published
gold rule; Northwind has GBP list prices. Try: Pricing & Metal Rates → Calculator → search `AUR-T-0001`. Propose a
rate as `owner@aurum.demo`, approve it as `rates@aurum.demo`.

Storefront quote: `POST /v1/storefront/pricing-quotes` with `Host: northwind.localhost` and body
`{"lines":[{"variantId":"<variant id>"}]}`.

## Orders demo (Phase 07)
Orders → New order (staff order on account), Orders → Quotations (send freezes the price), Orders → Settings
(approval threshold). Storefront checkout is API-only for now: `POST /v1/storefront/carts`, `PUT .../lines`
(`X-Cart-Token`), `POST /v1/storefront/checkouts` (`Idempotency-Key`), then
`POST /v1/storefront/orders/{id}/sandbox-payment` — a SANDBOX gateway, no real money.

## B2B demo (Phase 08)
Start the portal with `pnpm dev:portal` and open **http://aurum-b2b.localhost:3102** (browsers resolve
`*.localhost` to this machine; the domain picks Aurum's B2B storefront). Sign in as `buyer@shree.demo`:
Quick order → paste `AUR-BAND22-14, AUR-T-0003` → Get prices shows Shree's contract price build-up. Requests for
quote → New request; answer it in the merchant admin under Companies → RFQ inbox (`owner@aurum.demo`), then
"Send quotation" and accept some or all lines in the portal under Quotations. `approver@shree.demo` sees
Approvals. Companies → Shree shows locations, buyers (invite link), and the credit ledger (record a payment or
advance). The portal proxy reads `STOREFRONT_GATEWAY_KEY` from the environment or the repo `.env`.

## B2C demo (Phase 09)
`pnpm dev:store`, then open **http://northwind.localhost:3103** (general commerce, GBP) or
**http://lumiere.localhost:3103** (jewellery: product pages list each in-stock piece with its actual weights).
Register or sign in as `customer@lumiere.demo`, add to cart, check out, and pay with the SANDBOX buttons (no money
moves). In the merchant admin the order page now has Fulfillment (pack → ship with a hand-typed carrier → deliver),
Returns, Refunds (sandbox) and Customer messages (recorded, not sent); Orders → Returns lists return requests and
Customers lists storefront accounts with their consent history.

## Growth demo (Phase 10)
As `owner@northwind.demo`: **Online Store** → New page (add blocks, Save draft, Publish), edit the announcement banner,
theme and menus; "Preview drafts" gives a 15-minute storefront link. Add a domain ending in `.test` and Verify
(development verification; real domains need the shown DNS TXT record). **Discounts** → create a code; enter it in
the storefront cart. **Marketing** → create a segment and a campaign, then "Prepare audience" (only consented
customers; nothing is sent). **Analytics** → reports with formulas and CSV. Open the store with
`?utm_source=newsletter` to see attribution.
