# 01 Architecture, services, repository
## Baseline
Monorepo: `apps/platform-admin`, `apps/merchant-admin`, `apps/storefront-b2b`, `apps/storefront-b2c`, `apps/api`, `apps/worker`; `packages/ui`, `packages/contracts`, `packages/config`, `packages/connector-sdk`; `modules/{tenant,identity,catalog,jewellery,inventory,pricing,rates,customer,company,quote,cart,order,payment,tax,fulfillment,marketing,promotions,content,analytics,notifications,integrations,automation,audit}`; `infra/`, `docs/`.

## Responsibilities and boundaries
Single NestJS modular monolith exposing separate admin/storefront/platform scopes, with PostgreSQL as OLTP, Redis for cache/locks/queues (never sole persistence), BullMQ workers, object storage for assets. Outbox DB rows inserted in same transaction as business changes; workers publish/deliver at least once, consumer idempotency. Adapter workers isolated by connector and merchant, outbound desktop agent permitted (never open inbound merchant DB). Search starts PostgreSQL, move to dedicated search if measured need. Separate mutable product/editor metadata from physical stock and authoritative price.

## Multi-tenancy
Every tenant-owned row `tenant_id`; unique constraints scoped to tenant+source when appropriate; query-scoped repositories, authorization middleware and database RLS where appropriate. Tenant resolved from authenticated session + permitted membership or validated storefront domain. Never trust free client-supplied tenant_id. Protect cache keys, media storage, search and queues. Explicit merchant/store/channel/location dimensions. Partition larger installations only when measured.

## State machines
Quote: draft→sent→negotiating→accepted|expired|rejected→converted; Order: draft→pending_approval→confirmed→partially_fulfilled→fulfilled→completed, cancellation and return branches with guards. Payment: pending→authorized→captured|failed|voided; refund separately. Inventory reservation: requested→held→committed|released|expired; make idempotent. Sync job: queued→running→completed|partially_failed|failed→retriable/dead_letter. Publish approved rate via maker-checker.

## Concurrency
Transactional check-and-reserve with row locking or conditional update; locks scoped tenant/item/location; no Redis-only reservation authority; require idempotency key for checkout, webhook, ERP import and order outbound; unique reference mappings. Release/expire stale holds. Stock snapshot vs ledger reconciler; avoid double subtraction when ERP acknowledges sales. Version and timestamp ordering not sufficient alone if source clocks unreliable: establish monotonic sequence or fetch current authoritative snapshot.

## ADRs
Record decisions on tenancy, inventory authority, source-specific mapping, quoting, checkout rate-lock, invoicing authority, security, backorder, taxation. Record tradeoffs and rollback. Favor configuration + versioned policy definitions, not arbitrary untrusted executable formulas.

## DevOps
Docker Compose dev environment and test containers; .env.example; migrations and rollback notes; test fixtures; GitHub Actions lint/typecheck/unit/integration/build/dependency scan; staging seed; environment separation; health/readiness; metrics/logging/alerts. Deploy only with explicit approval.
