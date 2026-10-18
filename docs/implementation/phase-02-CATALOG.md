# Phase 02 — CATALOG: task plan

## Repo inspection summary (start of phase)
- Phase 01 approved and pushed (`c52825f` on `origin/main`). 144 unit/integration + 9 E2E tests green.
- Object storage: SeaweedFS (compose profile `storage`, ADR-012) verified working for bucket create/put/get.
- Risks: media upload size/type validation; search performance (pg_trgm needed); keeping jewellery data out of
  general-commerce products; `IMPLEMENTED_PHASE` bump makes Products nav visible — every new nav entry must work.

## Scope
Product, variant, category (tree), collection (manual), attribute definitions, media (S3) and SEO, channel
publication, searchable/filterable/sortable paginated product admin with saved views, server validation,
optimistic locking, CSV import preview + atomic commit, storefront catalog read API resolved by domain.
Product type `jewellery` is allowed only when the tenant is entitled to the `jewellery` feature; measurement
fields arrive in Phase 03. General products need no jewellery data.

Not in scope: prices (Phase 06), stock (Phase 04), ERP field ownership & connector imports (Phase 05; the CSV
import here is a merchant catalog import, not a connector), rule-based collections (Phase 10).

## Data model (migration 0002)
| Table | Key points |
|---|---|
| categories | tree via `parent_id`; slug unique per tenant; no cycles |
| attribute_definitions | key unique per tenant; type text/number/boolean/select; select options; required |
| products | title, slug (unique/tenant), status draft→active→archived, type standard/jewellery, description, brand, category, tags, options[], attributes jsonb (validated vs definitions), seo; version |
| variants | sku unique/tenant, barcode unique/tenant when set, option values (unique combination per product), status, position; version |
| collections + collection_products | manual membership with position |
| media_assets + product_media | S3 key, sha256, size, sniffed content type, alt text; ordered product gallery |
| channel_publications | (product, channel) unique; published/unpublished; who/when |
| saved_views | per-user or shared list filters for `products` |
| catalog_import_batches | CSV preview rows + errors; previewed→committed|discarded; commit atomic + once |

All tenant-owned, RLS-protected, composite tenant FKs; `pg_trgm` GIN indexes for search on title/SKU.

## Screen / action inventory (merchant admin)
| Route | User / permission | Backend | States / tests |
|---|---|---|---|
| `/t/:t/products` list | catalog.read | `GET /v1/admin/products?q&status&type&categoryId&collectionId&channelId&sort&cursor` + saved views CRUD | L/E/Ø/D; isolation, search, sort, paging |
| `/t/:t/products/new` | catalog.edit | `POST /v1/admin/products` (+ first variant) | validation, slug/SKU duplicates, jewellery entitlement |
| `/t/:t/products/:id` detail | catalog.read / edit / publish | `GET/PATCH /products/:id`, variants CRUD, media upload/reorder/remove, publications | version conflicts, status transitions, publish guards |
| `/t/:t/products/import` | catalog.edit | `POST /products/imports` (preview), `GET /imports/:id`, `POST /imports/:id/commit`, `/discard` | row errors, idempotent commit, re-import updates not duplicates |
| `/t/:t/categories` | catalog.read / edit | categories CRUD (tree) | cycle prevention |
| `/t/:t/collections` (+ detail) | catalog.read / edit | collections CRUD + membership | |
| `/t/:t/settings/attributes` | catalog.read / edit | attribute definitions CRUD | type validation |

## Storefront API (`/v1/storefront/*`, domain-resolved)
`GET catalog/products`, `GET catalog/products/{slug}`, `GET catalog/categories`, `GET catalog/collections/{slug}`,
`GET media/{id}` — only **active** products **published to the resolved channel** with active variants; no prices.

## State transitions
- Product: `draft → active → archived`, `archived → draft`; `active` requires ≥1 active variant. Archiving
  unpublishes from every channel (audited, outbox `ProductUnpublished`).
- Publication: `unpublished ⇄ published`; publish requires product `active`, channel active; emits `ProductPublished`.
- Import batch: `previewed → committed | discarded` (commit at most once; re-commit → 409).

## Acceptance cases
| ID | Case |
|---|---|
| C-01 | Tenant A cannot read/modify/publish Tenant B products, variants, media, categories, collections, imports (IDs, lists, storefront) |
| C-02 | SKU unique per tenant (same SKU allowed in another tenant); barcode unique per tenant; option-value combination unique per product |
| C-03 | Status rules: cannot activate without active variant; archived products not publishable; storefront shows only active+published |
| C-04 | Optimistic locking on product/variant/category/collection updates |
| C-05 | General-commerce product works without jewellery data; general tenant cannot create `jewellery` type |
| C-06 | Attribute values validated against definitions (type, select options, required) |
| C-07 | Media: type sniffed from bytes, size limit, tenant-scoped retrieval, unpublished media not served by storefront |
| C-08 | CSV import: preview reports per-row errors without writing products; commit is atomic and idempotent; re-import of same file updates, never duplicates |
| C-09 | Publish/unpublish audited and emits outbox events |
| C-10 | Saved views are per user unless shared; cannot read another user's private view |
| C-11 | Every new route documented in OpenAPI; nav shows Products only for entitled+permitted users |
| C-12 | E2E: create product → add variant → upload image → activate → publish → visible via storefront API; viewer read-only |

---

## Results (2026-10-18) — status: implemented, awaiting review

### Commands and outcomes
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 0 errors / 0 warnings |
| `pnpm typecheck` | 0 | all packages |
| `pnpm build` | 0 | API, worker, both admin apps (merchant admin now 20 routes) |
| `pnpm test` | 0 | **171 tests**: contracts 19, db 25, ui 2, api 120 (10 files; +27 for Phase 02), worker 5 |
| `pnpm test:e2e` | 0 | **13 Playwright tests** (+4 catalog flows) |
| `pnpm audit --audit-level high` | 0 | 0 high/critical |

### Acceptance coverage
| ID | Status | Evidence |
|---|---|---|
| C-01 isolation | PASS | `catalog.spec.ts` (read/patch/variant/publish/foreign channel/foreign category/media/search/storefront) |
| C-02 uniqueness | PASS | SKU case-insensitive per tenant, cross-tenant reuse, barcode, option combination, slug |
| C-03 status rules + visibility | PASS | lifecycle test (draft→active guard, last active variant, archive unpublishes, storefront 404s) |
| C-04 optimistic locking | PASS | product + variant (+ collections/categories/attributes via shared helper) |
| C-05 general vs jewellery | PASS | general product without jewellery data; `jewellery` type gated |
| C-06 attributes | PASS | required/select/decimal/unknown keys; in-use option removal blocked |
| C-07 media | PASS | byte sniffing, SVG/HTML rejected (415), 10 MB (413), tenant-scoped bytes, storefront only when visible, filename sanitised |
| C-08 CSV import | PASS | per-row errors, nothing written on preview, atomic once-only commit, re-import updates (no duplicates), stale-preview 409, idempotent upload |
| C-09 publish events/audit | PASS | `ProductPublished` / `ProductUnpublished` outbox + audit |
| C-10 saved views | PASS | private/shared/owner-only writes |
| C-11 OpenAPI + nav | PASS | route-coverage test (57 paths), nav shows Products/Collections/Categories/Product attributes |
| C-12 E2E | PASS | `e2e/tests/catalog.spec.ts`; screenshots `product-detail.png`, `products-list.png`, `csv-import.png` |

### Defects found and fixed during this phase
1. Array parameter inside a raw `sql` template (`= any(...)`) produced a 500 — switched to `inArray` (option-in-use check).
2. Body-parser errors (oversized or malformed JSON) returned 500 on **all** endpoints since Phase 01 — now 413/400 with the standard error envelope; JSON limit raised to fit the 2 MB CSV contract.
3. Import check for "existing variants not in the file" could never fire — now queries all variants of matched products.
4. UI: saved view not selected after saving; option button layout.

### Known gaps / carried over
- Worked example payloads per endpoint (contract) still pending; schemas complete.
- Media served through the API (no CDN); orphaned objects are cleaned on failed uploads and removals, but no periodic sweeper yet (Phase 11).
- Storefront apps (rendering) remain Phases 08/09; storefront catalog **API** is live.
- Nothing from Phase 02 is committed yet.
