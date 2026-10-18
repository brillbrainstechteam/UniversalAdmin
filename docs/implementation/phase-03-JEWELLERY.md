# Phase 03 — JEWELLERY: measurements and serialized jewellery — task plan

## Repo inspection summary (start of phase)
- Phases 01–02 approved and pushed (`e55ab1f`). 171 unit/integration + 13 E2E green. Infra (Postgres, Redis, SeaweedFS) up.
- Catalog has `productType: 'jewellery'` (entitlement-gated) but no measurement data yet.
- Risks: decimal precision (must never touch JS floats), unit ambiguity, HUID uniqueness across bulk entry,
  system roles already seeded in existing tenants need the new permission (data migration), keeping raw source
  values distinct from canonical grams.

## Scope
Per tenant **purity definitions** (metal + purity code + fineness, merchant-confirmed); per-variant **jewellery
spec** (design/nominal measurements, billing basis, QTY unit, pieces per unit, components); **serialized items**
(physical articles: serial tag, optional HUID, actual gross/net/stone/fine grams, pieces, components,
certificates); measurement **units** g/mg/kg/ct converted exactly to canonical grams with raw input preserved;
**fine weight** computed from purity with provenance (or entered and cross-checked); **validation** (non-negative,
6 dp precision, net ≤ gross unless a reviewed exception, stone weight vs components within tolerance); **edit
policy** (reasons for measurement corrections, HUID changes restricted, retired items read-only, maker-checker
review for exceptions); **detail and bulk forms** (bulk add up to 200 items with dry-run preview); jewellery
settings (tolerance, fine rounding scale, HUID format). General-commerce products are unaffected.

Not in scope: prices, making/wastage/stone rates (Phase 06), stock availability/locations/reservations (Phase 04),
ERP mapping (Phase 05), certification validity claims (we store references only).

## Measurement contract (specs/04)
| Field | Storage | Rule |
|---|---|---|
| gross_g, net_g, stone_g, fine_g | NUMERIC(20,6) grams | non-negative; ≤ 6 dp after conversion |
| input unit | raw JSON `{value, unit}` | g, mg, kg; ct only for stone/component weights (1 ct = 0.2 g exactly) |
| net vs gross | — | net ≤ gross, else item goes to `pending_review` with a reason; a different user with `jewellery.review` approves |
| fine_g | + `fine_source` computed/entered, `fine_formula` | computed = Σ(metal component g × fineness) or net × fineness, rounded half-up to the tenant's fine scale (default 3 dp); entered values are cross-checked within tolerance (warning) |
| gross vs net + stone | — | not overwritten; mismatch beyond tolerance is a **warning** (non-stone materials exist) |
| stone_g vs components | — | Σ stone components (ct→g) vs stone_g beyond tolerance is a **warning** |
| pieces / qty unit | integer ≥ 1 / piece, pair, set | displayed count kept separate from billable basis |
| HUID | text, unique per tenant, upper-case | format per tenant setting (default BIS 6-char alphanumeric, configurable pending validation) |

## Screens / actions
| Route | User / permission | Backend | States / tests |
|---|---|---|---|
| Product detail → variant **Jewellery spec** dialog | catalog.read / jewellery.edit | `GET/PUT /v1/admin/products/{id}/variants/{variantId}/jewellery-spec` | validation, version, units, entitlement |
| Product detail → **Serialized items** card (+ bulk add dialog with paste/dry-run) | catalog.read / jewellery.edit | `GET /v1/admin/serial-items?variantId=`, `POST /v1/admin/serial-items/bulk` | per-row errors, HUID duplicates, dry run writes nothing |
| `/t/:t/serial-items` list + `/serial-items/:id` detail/edit/review | catalog.read / jewellery.edit / jewellery.review | list, `GET/PATCH /v1/admin/serial-items/{id}`, `POST /{id}/review` | search by tag/HUID/SKU, edit policy, maker-checker |
| `/t/:t/settings/jewellery` | catalog.read / jewellery.edit | settings `GET/PUT`, purities `GET/POST/PATCH` | fineness bounds, version |

## Acceptance cases
| ID | Case |
|---|---|
| J-01 | Exact unit conversion and fine-weight computation (fixture table, half-up rounding, no float drift) |
| J-02 | gross/net/fine/stone and QTY/PCS persist and render independently in canonical grams; raw input preserved |
| J-03 | Three same-design pieces with different actual weights stored distinctly; HUID unique (single + bulk + update) |
| J-04 | net > gross without reason rejected; with reason → `pending_review`; self-review blocked; reviewer approves → active |
| J-05 | Edit policy: measurement correction on active item needs reason and is audited with old/new; HUID change needs `jewellery.review`; retired read-only |
| J-06 | Bulk: malformed rows quarantined (whole batch rejected with per-row paths); dry run writes nothing |
| J-07 | General-commerce tenant: no jewellery spec / serial items (entitlement), standard products unaffected |
| J-08 | Tenant isolation for specs, items, purities, settings |
| J-09 | Existing tenants' system roles receive the new permissions (data migration) |
| J-10 | OpenAPI route coverage; E2E: spec + bulk items + review flow in the admin |

---

## Results (2026-10-18) — status: implemented, awaiting review

### Commands and outcomes
| Command | Exit | Result |
|---|---|---|
| `pnpm format:check` | 0 | clean |
| `pnpm lint` | 0 | 0 errors / 0 warnings (incl. new no-float rule for measurement code) |
| `pnpm typecheck` | 0 | all packages |
| `pnpm build` | 0 | all apps |
| `pnpm test` | 0 | **211 tests**: contracts 40 (+21 precision fixtures), db 25, ui 2, api 139 (+19 jewellery), worker 5 |
| `pnpm test:e2e` | 0 | **16 Playwright tests** (+3 jewellery flows) |
| `pnpm audit --audit-level high` | 0 | 0 high/critical |

### Acceptance coverage
| ID | Status | Evidence |
|---|---|---|
| J-01 exact conversion + fine | PASS | `packages/contracts/test/jewellery-math.spec.ts` (fixtures where floats drift; half-up; precision-loss rejection; component sum rounded once) |
| J-02 independent canonical fields, raw kept | PASS | `jewellery.spec.ts` spec tests (mg/kg/ct → grams, raw `{value,unit}` preserved, pair/pieces) |
| J-03 same design, distinct weights, unique HUID | PASS | bulk of 3 pieces; batch/existing/case-insensitive HUID and tag collisions |
| J-04 maker-checker | PASS | reason required; pending_review; self-review 403; reviewer approves; non-reviewer 403 |
| J-05 edit policy | PASS | reason for corrections + audit old/new; HUID change needs review permission; retired read-only; exception auto-resolves |
| J-06 quarantine / dry run | PASS | schema-stage and rule-stage per-row paths; nothing written; dry run writes nothing |
| J-07 general commerce unaffected | PASS | API (feature gates, `jewellery: null`) + E2E (no nav, no card) |
| J-08 isolation | PASS | cross-tenant item/spec/purity access 404/400 |
| J-09 roles | PASS | DB roles equal code templates; data migration verified on the populated dev DB (owner/admin `jewellery.review`, inventory operator `jewellery.edit`) |
| J-10 OpenAPI + E2E | PASS | route coverage (65 paths); `e2e/tests/jewellery.spec.ts`, screenshots `serial-item-review.png`, `jewellery-settings.png` |

### Defects found and fixed during this phase
1. A float comparison slipped into the spec net-vs-gross check — replaced with exact decimal compare and guarded by a new lint rule.
2. NUL-byte sentinel in an `IN` list caused 500s on item creation (Postgres rejects `\u0000`).
3. Wrong test fixture caught by the precision tests (2.345678 ct is 7 dp in grams and is correctly rejected).

### Known gaps / carried over
- Per-article stock, location, availability and storefront per-piece pages: Phases 04/09.
- Making/wastage/stone rates and price computation: Phase 06.
- No CSV import for serial items yet (bulk paste/grid covers manual entry); connector imports with raw/canonical mapping: Phase 05.
- Certificates are stored references only; no lab verification is claimed.
- Nothing from Phase 03 is committed yet.
