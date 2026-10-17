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
