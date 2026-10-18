# API permission / action matrix (Phase 01)

Machine-readable contract: [`openapi.json`](openapi.json) (also served at `/v1/openapi.json`, UI at `/docs`).
All `/v1/admin/*` calls need a merchant session cookie + `X-Tenant-Id` of an **active** membership in an **active**
tenant; all `/v1/platform/*` calls need a platform session + platform role. Mutations need `X-UC-CSRF: 1`.

| Endpoint | Permission | Notes / guards | Audit action |
|---|---|---|---|
| GET /v1/admin/context, /home | any active member | nav = implemented ∩ entitled ∩ permitted | — |
| GET /v1/admin/settings/general | settings.read | | — |
| PATCH /v1/admin/settings/general | settings.manage | `version` required; currency/country platform-owned | settings.general.updated |
| GET /v1/admin/stores[/{id}] | stores.read | | — |
| POST /v1/admin/stores | stores.manage | code unique per tenant | store.created |
| PATCH /v1/admin/stores/{id} | stores.manage | `version` | store.updated |
| GET /v1/admin/channels[/{id}] | stores.read | | — |
| POST /v1/admin/channels | stores.manage | channel type must be entitled (`FEATURE_NOT_ENTITLED`) | channel.created |
| PATCH /v1/admin/channels/{id} | stores.manage | theme tokens validated | channel.updated |
| GET /v1/admin/locations[/{id}] | locations.read | filtered to membership location scope | — |
| POST /v1/admin/locations | locations.manage | unscoped members only (`LOCATION_OUT_OF_SCOPE`); bin needs parent | location.created |
| PATCH /v1/admin/locations/{id} | locations.manage | in-scope only; `version` | location.updated / deactivated / activated |
| GET /v1/admin/members | staff.read | | — |
| PATCH /v1/admin/members/{id} | staff.manage | no self-modification; only owners touch owners/grant Owner; cannot grant permissions you lack; last-owner guard | member.updated / suspended / reactivated (+ outbox MembershipChanged) |
| GET /v1/admin/invitations | staff.read | | — |
| POST /v1/admin/invitations | staff.manage | **Idempotency-Key**; escalation guard; link shown once | invitation.created |
| POST /v1/admin/invitations/{id}/revoke | staff.manage | pending only | invitation.revoked |
| GET /v1/admin/roles, /permissions | roles.read | | — |
| POST /v1/admin/roles, PATCH /v1/admin/roles/{id} | roles.manage | system roles read-only; known keys only; escalation guard | role.created / role.updated |
| GET /v1/admin/audit-events | audit.read | tenant rows only | — |
| GET /v1/platform/presets, /tenants[/{id}], /tenants/{id}/entitlements | platform.tenants.read | | — |
| POST /v1/platform/tenants | platform.tenants.manage | **Idempotency-Key**; atomic provisioning | tenant.provisioned (+ outbox TenantProvisioned) |
| PATCH /v1/platform/tenants/{id} | platform.tenants.manage | `version` | tenant.updated |
| POST /v1/platform/tenants/{id}/suspend, /reactivate | platform.tenants.manage | reason ≥5 chars; guarded transitions | tenant.suspended / reactivated (+ outbox) |
| PUT /v1/platform/tenants/{id}/entitlements | platform.entitlements.manage | reason required | tenant.entitlements_changed (+ outbox) |
| GET /v1/platform/audit-events | platform.audit.read | all tenants + platform events | — |
| POST /v1/auth/login, logout, logout-all; GET /me; invitations preview/accept | public / session | lockout, throttling, single-use invite tokens | auth.login / login_failed / account_locked / logout*, invitation.accepted |
| GET /v1/storefront/config | public | verified domain → active channel of active tenant; never a client tenant id | — |

Platform roles: `platform_owner` = all platform permissions; `platform_support` = tenants.read + audit.read.
Request, response and error **schemas** for every endpoint are in the OpenAPI document. Worked example payloads
per endpoint (contract requirement) are not yet written — tracked as a Phase 02 documentation task.

## Phase 02 — catalog

| Endpoint | Permission | Notes / guards | Audit action |
|---|---|---|---|
| GET /v1/admin/products[/{id}], categories, collections[/{id}], attribute-definitions | catalog.read | tenant-scoped; search/filter/sort/cursor | — |
| GET /v1/admin/media/{id}/content | catalog.read | tenant via header or `?tenantId=` (GET only, membership enforced) | — |
| POST/PATCH /v1/admin/products, variants | catalog.edit | `jewellery` type needs entitlement; SKU/barcode/option uniqueness; status transitions; `version` | product.created / updated / activated / archived / set_draft, variant.created / updated |
| POST/PATCH/DELETE /v1/admin/products/{id}/media | catalog.edit | sniffed images ≤10 MB, ≤50 per product | product.media_added / updated / removed |
| PUT/DELETE /v1/admin/products/{id}/publications/{channelId} | catalog.publish | product must be active, channel active and own; idempotent | product.published / unpublished (+ outbox) |
| POST/PATCH/DELETE categories; POST/PATCH collections, PUT collections/{id}/products; POST/PATCH attribute-definitions | catalog.edit | cycle check; only empty categories deletable; removing an in-use select option rejected | category.*, collection.*, attribute.* |
| GET/POST/PATCH/DELETE /v1/admin/saved-views | catalog.read | private unless shared; only owner may change | — |
| GET/POST /v1/admin/catalog/imports, GET {id}, POST {id}/commit, {id}/discard | catalog.edit | **Idempotency-Key** on upload; ≤1000 rows; commit once, re-validated | catalog.import_previewed / committed / discarded |
| GET /v1/storefront/catalog/*, /v1/storefront/media/{id} | public (domain-resolved) | active + published + ≥1 active variant; no internal ids, no prices | — |

## Phase 03 — jewellery

| Endpoint | Permission | Notes / guards | Audit action |
|---|---|---|---|
| GET /v1/admin/jewellery/settings, /purities | catalog.read | feature `jewellery` | — |
| PUT /v1/admin/jewellery/settings; POST/PATCH /v1/admin/jewellery/purities | jewellery.edit | `version`; fineness 0 < f ≤ 1; saving a fineness confirms it | jewellery.settings_updated, jewellery.purity_created / updated / confirmed |
| GET/PUT /v1/admin/products/{id}/variants/{variantId}/jewellery-spec | catalog.read / jewellery.edit | jewellery products only; units g/mg/kg (ct for stones); `version` to replace | jewellery_spec.created / updated |
| GET /v1/admin/serial-items[/{id}] | catalog.read | feature `serialized_items` | — |
| POST /v1/admin/serial-items, /bulk | jewellery.edit | HUID/tag unique per tenant; net > gross needs a reason → pending_review; bulk ≤ 200, atomic, `dryRun` | serial_item.created / bulk_created |
| PATCH /v1/admin/serial-items/{id} | jewellery.edit (+ jewellery.review to change an assigned HUID) | reason required for measurement/HUID changes on active items; retired = read-only | serial_item.updated / measurements_corrected / huid_corrected / retired |
| POST /v1/admin/serial-items/{id}/review | jewellery.review | reviewer ≠ creator/last editor (`SEPARATION_OF_DUTIES`) | serial_item.exception_approved / rejected |

System roles: owner/admin gain `jewellery.review`; inventory operator gains `jewellery.edit` (data migration 0006 for existing tenants).

## Phase 04 — inventory

All endpoints need the `inventory` feature. Location-bound actions require the location to be inside the member's location scope (`LOCATION_OUT_OF_SCOPE`); reads are filtered to the scope.

| Endpoint | Permission | Notes / guards | Audit action |
|---|---|---|---|
| GET /v1/admin/inventory/summary, levels, variants/{id}, movements, reservations, transfers[/{id}], counts[/{id}], issues, settings, channels | inventory.read | scope-filtered; channel ATP only for unscoped members | — |
| PUT /v1/admin/inventory/settings | inventory.adjust | `version`; TTL 1–10080 min | inventory.settings_updated |
| PUT /v1/admin/inventory/variants/{id}/settings | inventory.adjust | `version` (0 = none yet); tracking/unit locked once the variant has stock history; piece tracking needs `serialized_items` | inventory.variant_settings_updated |
| PUT /v1/admin/inventory/channels/{id}/locations | stores.manage | unscoped members only | channel.stock_locations_updated |
| POST /v1/admin/inventory/receipts | inventory.adjust | **Idempotency-Key**; reference unique per type (409 DUPLICATE); pieces must be active and not yet received | inventory.received (+ outbox InventoryMovementRecorded) |
| POST /v1/admin/inventory/adjustments | inventory.adjust | **Idempotency-Key**; reason code + note; never below 0 or below reserved+committed (409 INSUFFICIENT_STOCK); quantity-tracked only | inventory.adjusted |
| POST /v1/admin/inventory/condition-changes | inventory.adjust | sellable ↔ damaged ↔ quarantine; note required | inventory.condition_changed |
| POST /v1/admin/inventory/serial-items/{id}/write-off | inventory.adjust | piece must be in stock (not held/committed/in transit) | serial_item.written_off |
| POST /v1/admin/inventory/reservations | inventory.reserve | **Idempotency-Key** stored on the hold (replay → 200); ATP − buffer; serial variants need `serialItemId` | reservation.created (+ ReservationCreated) |
| POST /v1/admin/inventory/reservations/{id}/commit | inventory.reserve | held and not expired (RESERVATION_EXPIRED) | reservation.committed (+ ReservationCommitted) |
| POST /v1/admin/inventory/reservations/{id}/release | inventory.reserve | held, or committed with a reason | reservation.released (+ ReservationReleased) |
| POST /v1/admin/inventory/transfers | inventory.transfer | **Idempotency-Key**; source in scope; stock moves to the destination's in transit | transfer.dispatched |
| POST /v1/admin/inventory/transfers/{id}/receive, /cancel | inventory.transfer | `version`; receive needs destination scope, cancel source scope | transfer.received / transfer.cancelled |
| POST /v1/admin/inventory/counts | inventory.adjust | `dryRun` previews; older `asOf` → rejected_stale + issue; below holds → 409 | inventory.counted / inventory.count_rejected_stale (+ InventorySnapshotReceived) |
| POST /v1/admin/inventory/issues/{id}/resolve | inventory.adjust | note ≥ 5 chars; open only | reconciliation_issue.resolved (+ ReconciliationIssueResolved) |
| POST /v1/admin/inventory/reconcile | inventory.adjust | ledger vs balances vs reservations vs pieces | inventory.reconciled (+ ReconciliationIssueOpened per new issue) |

Phase 03 change: retiring a serialized item (or rejecting its review) now requires stock state `not_received` or `written_off`.
System roles (data migration 0008): owner, admin, inventory operator and sales rep gain `inventory.reserve`; sales rep gains `inventory.read`.
Worker (no HTTP): expires due holds every 15 s and reconciles every 10 min across tenants.
