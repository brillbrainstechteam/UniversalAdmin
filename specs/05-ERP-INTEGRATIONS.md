# 05 Universal ERP integration spec
## Honest support tiers
Certified vendor API connector (only after docs+credentials+tested capability); vendor-approved file connector; desktop outbound agent; generic CSV/XLSX/XML import and export; simulator. Candidate qualification: Synergics, TallyPrime, JewelACC, ORNATE, MARG and other regional solutions. Do NOT state they all have usable external APIs or writeback. Capture software, edition, hosting/on-prem, vendor auth, export format, external identifier stability, change feed, location/serial granularity, rate field semantics, transaction/writeback and commercial terms. Maintain capability matrix per connector/version. No direct unsanctioned production DB writes.

## SDK operations
capabilities(); testConnection(); discoverSchema(); fetchProducts(cursor); fetchStock(cursor); fetchRates(cursor); fetchCustomers(cursor); receiveWebhook(payload,verify); pushOrder(command); fetchOrderStatus(); acknowledgeReservation() optional; reconcile(); health(); disconnect(). Adapters declare supported/unsupported per operation, polling interval and rate caps. Schema mapping UI for source field->canonical, unit transforms, required checks, sample preview, row error exports, duplicate handling and mapping version.

## Field ownership & precedence
Per tenant entity/field owner one of ERP, commerce, provider, approved manual; catalog title/media/SEO commonly commerce; SKU/serial/weights/stock ERP if configured; ATP computed by commerce against authoritative snapshots and unacknowledged holds; rate provider/manual per policy; invoice ERP if merchant chooses. Generic patch cannot update ERP-owned stock. Bi-directional only for specifically supported fields with reconciliation protocol. Track external version, source timestamp, ingest time, checksum, sync batch and provenance.

## Initial and incremental sync
Wizard software/edition/connect/auth/test/sample/map/review/initial dry-run/approval/full import/incremental/reconciliation/test sale/live. Import staging tables validate tenant, sku/external id, unit conversions, duplicates, incompatible weights, negative stock and missing locations. Atomic/partial batch option with per-row feedback, never discard source record silently. Incremental webhook/poll/file uses idempotent event key, tombstones and explicit deletion policy, monotonic checkpoint, retries/backoff and dead-letter queue. Weekly full reconciliation initially configurable.

## Reservation/order export race
Reserve internally with DB transaction before order confirmation. Enqueue outbound ERP order using transactional outbox and stable idempotency reference. If ERP supports real stock holds, acknowledge/commit; otherwise sellable buffer, freshness gating and/or approval flow. ERP snapshot carrying accepted sale must reconcile/remove matched outstanding reservation impact to avoid double subtract. If export fails, show `export_pending` operational exception, never mark externally accepted. Compensate cancellations/reversals with audit and supported commands, never mutate stock balance without ledger.

## Desktop agent
Merchant-controlled install with outbound HTTPS and credentials scoped to tenant/connector, optional local source read under vendor permission, secure update/rotation, durable local queue/checkpoint, minimal data capture, no exposed inbound ports, clear uninstall/revoke. Design first; implementation after a confirmed local-software pilot.

## UI
Connector catalog, capability details, add connection, mapping template, sample preview, status/freshness, last sync, job/row failure drilldown, unresolved stock discrepancies, manual resync with warning, disconnect/reauthorize, source authority matrix and SLA status. Exports respect permissions and PII minimization.

## Test fixtures
Duplicate initial import, update without new duplicate, out-of-order event, re-run batch, collision between ERP serial and commerce SKU, malformed weight unit, rate missing purity, partial feed, outage, retry after outbound timeout, ERP acknowledged order and next snapshot, two channels buying last piece, branch-specific stock, catalog image retained on ERP import. Do not mark connector production-supported until sandbox/pilot acceptance passes.
