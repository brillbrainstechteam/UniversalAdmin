# Phase 11 — Operations: integration operations and hardening — task plan

## Repo inspection summary (start of phase)
- Phases 01–10 committed locally (`84546bb`, not pushed). 341 unit/integration + 32 E2E green.
- In place: transactional outbox → BullMQ relay with a `dead` state (no admin view or replay), worker loops
  (inventory, ERP sync/export, rates, orders), readiness/liveness health, audit log, correlation IDs, sandbox
  payment gateway, connector SDK for ERP adapters, credential *references* for connectors (no stored secrets),
  login throttling (Redis, fail-open), sessions per audience. No MFA, no API keys, no outbound webhooks, no ops
  dashboard, no backup scripts. Customer messages and campaigns are recorded but cannot be sent (no connector).
- Risks: SSRF through merchant-supplied webhook URLs; webhook secrets leaking or stored in plain text; API keys
  broader than their creator or usable for writes; MFA bypass via a second login path; dead events lost silently;
  automations triggering themselves; backups never tested.

## Scope
- **Outbound webhooks** (`webhooks.manage`): endpoints (https URL, subscribed event types from an allowlist,
  signing secret shown once and stored encrypted with AES-256-GCM under `SECRETS_ENCRYPTION_KEY`). Domain events of
  the tenant fan out to deliveries; the worker POSTs JSON with `X-UC-Signature: t=<unix>,v1=<hmac-sha256(t.body)>`,
  `X-UC-Event-Id` (receiver dedupe), 10 s timeout, exponential retries, `dead` after 8 attempts, manual replay,
  per-endpoint disable after repeated failures is shown (not automatic deletion). URLs to private/loopback/link-local
  addresses are refused unless `WEBHOOKS_ALLOW_PRIVATE_TARGETS=true` (development/test only; refused in production).
  Test-send action.
- **Automations** (feature `automations`, `integrations.manage`): typed rules — trigger from an allowlist of domain
  events, optional typed conditions (order total ≥, channel), actions from an allowlist (deliver to a webhook
  endpoint, notify staff in the in-app inbox). Actions never emit domain events, so rules cannot trigger each other
  (loop guard); every run is logged with outcome; failures retry through webhook deliveries.
- **Staff notifications inbox**: in-app notifications for staff (automation action + operational alerts), mark read.
- **API keys** (`apikeys.manage`): tenant keys with read-only scopes (catalog/inventory/orders/pricing/customers
  read), optional expiry; secret shown once, SHA-256 stored, prefix visible; revoke and rotate. A key acts for its
  creator with permissions = creator's current permissions ∩ scopes, GET only; every use updates last-used; audit
  records key creation/revocation.
- **MFA (TOTP, RFC 6238)** for staff and platform operators: enrol (secret + otpauth URI, confirm with a code),
  10 single-use recovery codes (hashed), disable with password + code. Sign-in with MFA returns a short-lived
  challenge; the session is created only after a valid code. Tenant setting "require MFA for owners/admins"
  blocks admin API use until enrolled.
- **Operations health** (`operations.read`; platform view for operators): outbox backlog/dead, webhook deliveries
  (failing/dead), ERP connector freshness and order-export lag, open reconciliation issues by age, stale metal rates,
  checkout/payment failures (24 h), stock reservations near expiry; thresholds with status ok/warn/alert. Platform:
  dead outbox events list + replay.
- **Connector interfaces**: SDK interfaces for payment, shipping and notification providers, registry with the
  sandbox payment gateway (existing) and the blocked real providers; status shown honestly in Integrations.
- **Bulk workflow**: orders CSV export (filters as the list), formula-injection safe.
- **Backups**: `scripts/backup.sh` (pg_dump custom format), `scripts/restore-drill.sh` (restore into a scratch DB,
  run invariant checks: row counts, ledger = balances, no negative stock, refunds ≤ captured); runbook with proposed
  RPO/RTO; drill executed and recorded.
- **Audits**: automated accessibility checks (axe) on key admin/storefront pages in E2E; security review checklist;
  performance fixture script (bulk data + timed endpoints) with recorded numbers; outage tests (webhook receiver
  down → retries/dead/replay; Redis down → throttling fails open but sessions/health report degraded).

## Acceptance cases
| ID | Case |
|---|---|
| P-01 | Webhook: subscribed event delivered once with valid signature; receiver can verify; unsubscribed events not sent |
| P-02 | Receiver down → retries with backoff → dead after max attempts → replay delivers; private-address URLs refused |
| P-03 | Webhook secrets encrypted at rest; shown once; rotate invalidates old signature |
| P-04 | API key: read with scope works, write refused, out-of-scope refused, revoked/expired refused, other tenant refused, creator losing membership disables key |
| P-05 | MFA: enrol/confirm, login requires code, wrong/replayed code refused, recovery code single-use, tenant MFA requirement enforced |
| P-06 | Automations: trigger + condition → action runs and is logged; non-matching skipped; actions cannot retrigger |
| P-07 | Ops health reports real backlog/dead/lag figures; dead outbox replay (platform) re-publishes |
| P-08 | Orders CSV export matches the list filters; permission enforced |
| P-09 | Backup/restore drill: restored DB passes invariant checks |
| P-10 | Accessibility: no serious/critical axe violations on audited pages |

## Not in scope / blocked
- Real shipping/notification/payment providers (accounts and keys), SMS/WhatsApp template approval, external
  monitoring/alert routing (pager/email), managed backups and point-in-time recovery (hosting, Phase 12).

## Results (2026-10-20) — status: implemented, awaiting review

### Gate commands
| Command | Outcome |
|---|---|
| `pnpm format:check` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm test` | exit 0 — 351 passed (contracts 66, connector-sdk 8, ui 2, db 25, api 240, worker 10) |
| `pnpm e2e` | exit 0 — 35 passed |
| `pnpm audit --prod` | exit 0 |
| `pnpm openapi:generate` | regenerated (`1.0.0-phase11`) |

### Acceptance coverage
| ID | Where | Result |
|---|---|---|
| P-01 | `apps/api/test/integration/ops.spec.ts` (signed delivery, receiver verifies, unsubscribed not sent) | pass |
| P-02 | ops.spec (receiver down → backoff → dead after 8 → replay; private URLs refused 422 UNSAFE_URL) + `apps/worker/test/ops-jobs.spec.ts` | pass |
| P-03 | ops.spec (sealed at rest, shown once, rotate invalidates old signature) | pass |
| P-04 | ops.spec (GET with scope, write/out-of-scope/revoked/expired/other tenant refused, removed creator disables key) | pass |
| P-05 | ops.spec + `e2e/tests/ops.spec.ts` (enrol, login challenge, replay/wrong code, single-use recovery, tenant requirement) | pass |
| P-06 | ops.spec (condition match runs + logged once, non-match skipped, actions cannot retrigger) | pass |
| P-07 | ops.spec (health figures from tables, platform dead-event replay) | pass |
| P-08 | ops.spec (CSV matches list filters, permission enforced, formula-safe) | pass |
| P-09 | `scripts/restore-drill.sh` on uc_dev and uc_test — 7/7 invariants = 0 (see `docs/runbooks/BACKUP-RESTORE.md`) | pass |
| P-10 | `e2e/tests/ops.spec.ts` axe scan of admin and storefront pages — no serious/critical violations | pass |
| Outage | ops.spec: Redis down → `/health/ready` 503 reporting redis down, login still 200 (throttling fails open) | pass |

### Performance (fixtures: 5 000 products, 20 000 orders; `pnpm --filter @uc/api perf`, local machine)
| Endpoint | p50 ms | p95 ms |
|---|---|---|
| Admin products list | 51 | 142 |
| Product search | 69 | 116 |
| Orders list | 85 | 114 |
| Orders search | 88 | 124 |
| Sales report | 106 | 216 |
| Orders CSV export (10 000 rows) | 539 | 670 |
| Operations health | 66 | 101 |
| Storefront catalog | 48 | 107 |
| Pricing quote (10 lines) | 137 | 253 |

Local numbers on a developer machine; they are a baseline, not a production SLO.

### Defects found and fixed
1. Storefront banner/header text was white on any accent colour (axe contrast violation) → `readableOn()` picks dark or light text.
2. Storefront per-IP rate limits (carts, checkout, pay, quotes) were hard-coded; suites share one client IP and Redis DB, so later suites hit 429. The limits now scale with `STOREFRONT_RATE_LIMIT_MULTIPLIER` (default 1; tests/E2E 50). The quote throttling test still asserts 429. This is a likely cause of the intermittent Phase 07 O-06 failure.
3. OpenAPI route registry rejected 202 responses → status union extended.
4. Restore drill first failed because uc_dev was not migrated to 0022 → migrated; drill passed.

### Not done / blocked
Real payment/shipping/notification providers, alert routing, and managed backups/PITR remain blocked (see `docs/integrations/BLOCKED-DEPENDENCIES.md`). MFA for buyer-portal and storefront accounts is out of scope (ADR-026).
