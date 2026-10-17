# 06 Security, compliance and operations
## Access and safety
Tenant authorization on every nested resource; per-role field masking (PII, cost, rate editing, accounting); B2B buyer company/location scopes; MFA for privileged operators; protected maker-checker on overrides; session revocation and rate limiting; encrypt secrets at rest, use secret refs, redact logs, signed inbound webhooks with replay protection, outbound retries/idempotency; input and upload validation; malware/image policy as appropriate; export access audit. Platform impersonation requires time-limited documented permission.

## Data & financial integrity
Avoid float math; rate/formula/tax/discount/order snapshot retained; ledger for stock, payments and credits, append-only audit events. Run invariant checks for negative stock, duplicate serial sell, cross-company pricing, refund exceeding captured sum, partial allocation overflow, timezone/effective-dated rate overlap. Backup with restore drills and specified RPO/RTO after operations assessment. Reconciliation alerts and manual review workflow.

## India-specific policy boundaries
GST registration/HSN/rate/IGST vs CGST/SGST place-of-supply and e-invoicing/e-waybill applicability configurable and externally validated with accountant/legal advisor; use a versioned tax rule provider, no unsupported blanket rate assumptions. BIS/HUID/hallmark fields and documents supported, applicability validated. Comply with consent/privacy/retention rules as applicable; consent evidence for marketing; approved channel templates. Do not claim certification merely because data fields exist.

## Operational dashboards
Job queue lag, import throughput/failures, connector heartbeat/freshness, unresolved reconciliation aging, stock lock contention, metal-rate staleness, order-export lag, checkout failures, payment webhook mismatch, tenant usage and costs. Correlation IDs end to end, environment segregated; automated alert thresholds configured by operator. Graceful outages and retry policies, DLQ with admin review and safe replay.

## Quality policy
Unit, migration, repository/permission, contract, integration (Testcontainers), deterministic fake connector, e2e Playwright for key flows, accessibility baseline, security scan, fixture-based exact decimal calculations. Performance/load testing for representative SKU count and concurrent last-item orders, error budgets defined after pilot. Never substitute visual snapshots for business invariant tests.
