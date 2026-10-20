# Phase 12 — LAUNCH: provisioning, regression, pilot readiness

Status: implemented, awaiting review (2026-10-20). Prior phases 01–11 are implemented; 11 committed locally (f9b21bc).

## Starting point
Already present from earlier phases: tenant list/create (owner invitation)/edit/suspend/reactivate, preset +
entitlement overrides (Phase 01), platform audit log, platform operations health (Phase 11), MFA for operators,
CI workflow (`.github/workflows/ci.yml`: audit, format, lint, typecheck, OpenAPI drift, tests, build, seed, E2E).

Missing for launch: plans and usage limits, a guided merchant setup, controlled support access, a pilot connector
readiness view, systematic cross-tenant/route sweeps, an E2E matrix over presets/roles/viewports, and release,
staging and pilot runbooks.

## Scope (vertical slice)
1. **Plans and usage (platform).** Global `plans` (key, name, description, limits: products, staff seats,
   locations, storefront domains, orders per month). `tenants.plan_key` (default `pilot`). Usage is computed live
   from the tables (no counters to drift). Hard limits on products, staff seats (active members + pending
   invitations), locations and domains: `422 PLAN_LIMIT_REACHED`, checked under a per-tenant advisory lock so
   concurrent creates cannot exceed them. Orders per month is **soft**: shown as a warning, never blocks a sale.
   No billing: subscription charging needs a billing provider (blocked); plans carry no price.
2. **Merchant setup checklist.** `GET /v1/admin/setup` computes steps from real state: business profile, location,
   store/channel, staff invited, products, metal rates (jewellery presets only), payment sandbox / provider status,
   storefront domain, catalog import or connector, first order. Shown as a Setup page and a Home card.
3. **Support access (just-in-time, audited, approved).** A platform operator requests access to one merchant
   with a reason, optional ticket reference and duration (15–120 min). The merchant's owners are notified
   (staff inbox) and approve or deny in Settings → Support access. Only the requesting operator can then start a
   support session: a merchant-audience session bound to that grant, **read-only** (GET only), with the
   merchant's `viewer` permissions, ending at the grant's expiry. Every request made in the session is audited
   (`support.request`), as are request/approve/deny/start/revoke. Owners or the operator can revoke at any time;
   revocation ends the sessions immediately. Merchant admin shows a persistent "Support session" banner.
4. **Pilot connector checklist.** `GET /v1/admin/integrations/connections/:id/pilot-checklist`: credentials,
   field ownership, active mapping, dry-run preview, committed full import, incremental run / checkpoint,
   reconciliation clear, order export acknowledged, and "production support" — always blocked until the vendor
   connector passes sandbox/pilot acceptance (spec 05); nothing here marks a connector certified.
5. **Multi-tenant hardening.** Route-matrix tests driven by `API_ROUTES`: every admin route → 401 without a
   session, 403 for a merchant the user is not a member of; every platform route → 401 with a merchant session.
   RLS sweep: for every tenant table, a tenant-A transaction sees no tenant-B rows.
6. **E2E matrix.** Presets (general commerce hides jewellery), roles (viewer read-only), phone viewport smoke,
   support-access flow with banner and refused write, setup checklist.
7. **Runbooks.** Staging deploy (CI/CD design, no deployment performed), release + rollback, incident response,
   pilot readiness checklist with residual risks.
8. **Seed.** Plans assigned to demo tenants; demo stays labelled.

Not in scope / blocked: production deployment and hosting, billing/subscription charging, live metal-rate feed,
vendor ERP certification, real payment/shipping/notification providers.

## Screens and actions
| Screen / action | Route (UI → API) | User / permission | Precondition | DTO | Persistence | States | Test |
|---|---|---|---|---|---|---|---|
| Plans list / edit | platform `/plans` → `GET/PUT /v1/platform/plans[/:key]` | operator, `platform.plans.manage` (edit), `platform.tenants.read` (view) | — | `Plan`, `SavePlanRequest` | `plans` | loading, empty, 422 validation | L-01 |
| Tenant plan + usage | platform `/tenants/:id` → `PUT /v1/platform/tenants/:id/plan`, `GET …/usage` | `platform.plans.manage` / `platform.tenants.read` | tenant exists | `AssignPlanRequest`, `PlanUsage` | `tenants.plan_key`, audit | over-limit warning | L-01, L-02 |
| Merchant plan & usage | admin `/t/:id/settings/plan` → `GET /v1/admin/plan` | member (any) | — | `PlanUsage` | read | near/over limit badges | L-02 |
| Limit enforcement | product/location/invitation/domain create | existing permissions | — | `PLAN_LIMIT_REACHED` | advisory lock | 422 message with limit | L-03 |
| Setup checklist | admin `/t/:id/setup`, Home card → `GET /v1/admin/setup` | member (any) | — | `SetupChecklist` | read | all done / progress | L-04 |
| Request support access | platform `/tenants/:id` → `POST /v1/platform/tenants/:id/support-grants` | `platform.support.request` | tenant active | `RequestSupportAccess` | `support_grants`, inbox, audit | 422 reason | L-05 |
| Support grants (merchant) | admin `/t/:id/settings/support` → `GET /v1/admin/support-grants`, `POST …/:id/approve|deny|revoke` | `support.manage` (owner) | requested / approved | `SupportGrant` | `support_grants`, sessions revoked, audit | empty, expired | L-05 |
| Start support session | platform → `POST /v1/platform/support-grants/:id/start` | requesting operator | approved, unexpired | `SupportSessionStarted` | `sessions.support_grant_id` | 409 not approved | L-05 |
| Support banner | merchant admin layout (`GET /v1/auth/me` → `support`) | — | support session | `MeResponse.support` | — | ends at expiry | L-05, E2E |
| Pilot checklist | admin `/t/:id/integrations/:connId` → `GET …/pilot-checklist` | `integrations.read` | connection | `PilotChecklist` | read | blocked step explained | L-06 |

## Acceptance cases
| ID | Case |
|---|---|
| L-01 | Plans CRUD (platform-only, validated, audited); assign plan to tenant (audited) |
| L-02 | Usage equals independent counts; merchant sees only its own plan/usage |
| L-03 | Hard limits refuse with 422 PLAN_LIMIT_REACHED, also under concurrent creates; orders over the soft limit still succeed |
| L-04 | Setup checklist steps flip as real data is added; jewellery-only steps hidden for general commerce |
| L-05 | Support access: reason required; owner-only approval; only requester starts; read-only; other merchant refused; per-request audit; expiry and revoke end access; deny |
| L-06 | Pilot checklist reflects real sync state; production support stays blocked |
| L-07 | Route matrix (401/403 for every admin and platform route) and RLS sweep over all tenant tables |
| L-08 | E2E matrix: presets, roles, phone viewport, support banner flow, setup checklist |
| L-09 | Seed from a clean DB is deterministic and labelled demo, plans assigned |
| L-10 | Runbooks: staging deploy, release/rollback, incident, pilot readiness with residual risks |

## Results (2026-10-20) — status: implemented, awaiting review

### Gate commands
| Command | Outcome |
|---|---|
| `pnpm format:check` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test` | exit 0 — 363 passed (contracts 66, connector-sdk 8, ui 2, db 25, api 252, worker 10) |
| `pnpm test:e2e` | exit 0 — 41 passed |
| `pnpm audit --prod` | exit 0 |
| `pnpm openapi:generate` | regenerated (`1.0.0-phase12`) |

### Acceptance coverage
| ID | Where | Result |
|---|---|---|
| L-01 | `apps/api/test/integration/launch.spec.ts` (plan CRUD, versions, pilot cannot retire, permissions, audit; assign needs reason, refuses unknown/retired) | pass |
| L-02 | launch.spec (usage = independent SQL counts; platform and merchant views agree; other merchant 403) | pass |
| L-03 | launch.spec (3 concurrent creates for 1 slot → 201/422/422; locations and invitations refused; soft monthly order limit: order still confirmed, usage `over`) | pass |
| L-04 | launch.spec + E2E (steps flip with real data; metal-rate step only for jewellery presets) | pass |
| L-05 | launch.spec + E2E (reason/duration validated; owner-only approval; requester-only start; one-time 60 s handoff; read-only; no customers/audit; other tenant 403; MFA changes refused; per-request audit; revoke and expiry end the session; deny) | pass |
| L-06 | launch.spec (checklist follows real sync jobs; production support blocked; unknown connection 404) | pass |
| L-07 | launch.spec route matrix (every admin route 401 anonymous / 403 non-member; every platform route 401 anonymous / merchant) and RLS sweep over every table with a tenant policy | pass |
| L-08 | `e2e/tests/launch.spec.ts` (preset matrix, role matrix, 375 px viewport without horizontal scroll, setup/plan pages with axe, support flow with banner, platform plans with axe) | pass |
| L-09 | seed from a clean DB in CI and test setup; demo tenants on Pilot/Growth, still labelled demo | pass |
| L-10 | `docs/runbooks/STAGING-DEPLOY.md`, `RELEASE.md`, `INCIDENT-RESPONSE.md`, `PILOT-READINESS.md` | written |

### Decisions
ADR-027 (plans and limits, setup checklist, support access design with handoff code, pilot checklist, sweeps).

### Defects found and fixed
1. A support session would have been able to call account-security endpoints (MFA enrol) for the operator's user —
   support sessions are now ignored there.
2. The admin context of a support session had no role (no membership) — it now shows "Support (read-only)" and the
   banner data.
3. Setting the support cookie directly from the platform console only works when both apps share a host —
   replaced with a one-time handoff code redeemed by the merchant admin.
4. `STOREFRONT_RATE_LIMIT_MULTIPLIER` is now refused above 1 in production.
5. E2E selector ambiguity on the tenant page (two "Reason" fields) — scoped to the dialog.

### Not done / blocked
No deployment (hosting, domains, TLS and the user's approval needed); subscription billing; live metal rates; vendor
ERP certification; real payment/shipping/notification providers; alert routing; managed PITR. Residual risks are
listed in `docs/runbooks/PILOT-READINESS.md`.
