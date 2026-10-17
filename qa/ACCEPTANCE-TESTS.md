# QA acceptance gates
## Cross-cutting P0
- Tenant A cannot read/write Tenant B resources via direct URL, guessed IDs, API, file or queue.
- Restricted B2B buyer cannot access another company/location, price book or invoice.
- Permission denied is enforced server-side; sensitive actions create audit events and require dual approval where configured.
- No silently mocked persisted state; all visible metrics have source and freshness; errors actionable.
- Migrations deterministic from clean DB; seed and backup/restore scripts work in non-prod; CI clean.

## Catalog, weights, price
- General commerce product works without jewellery metadata.
- Gross/net/fine/stone weights and QTY/PCS import/persist/render independently in canonical units; malformed fields quarantined.
- Three same-design physical jewellery pieces with different actual weights price accurately and cannot share HUID incorrectly.
- Gross-based and net-based customer price rules generate fixture-verified exact amount; combinations of per gram/per piece making, stone and discount have explicit breakdown and no float drift.
- Approved rate can be manual/provider with source/time; stale provider policy enforced; old confirmed order unaffected by new rate; quote TTL and price revalidation work.
- Two concurrent last-article checkouts result at most one confirmed sale; expired reservation released correctly.

## ERP/inventory
- Reimport same 1000 records does not duplicate; field ownership protects editorial media and authoritative stock.
- Event dedupe, older snapshot, wrong unit, unknown source ID, deleted source record, multi-warehouse and partial feed handled with audit/reconciliation.
- Accepted ERP order + subsequent stock snapshot does not double subtract same sale; failed outbound remains exception; retry with same key never duplicates ERP order.
- Polling-only source never advertised as real-time; disconnection visible and checkout risk policy enforced.

## Commerce
- B2B buyer submits RFQ, receives company price, approvals, accepts unexpired quote, credit/deposit validated, confirms and partially fulfills without accounting mismatch.
- B2C customer selects serialized item, gets authoritative checkout reprice and acknowledgment when required, sandbox payment response signed/handled, order reserves correct item, receives coherent status.
- Refund ≤ captured amount; partial shipments and cancellation issue compensating stock entries; invoice authority consistent and traceable.
- Marketing respects consent; segment permissions enforced; discount eligibility/expiry and combination tests pass.

## Release gates
Each phase ships code, migration, tests, UI demo, OpenAPI, audit/security review, failure/empty states, docs and precise known blockers. Phase cannot be declared finished because component renders or mocked service returns 200. Vendor production adapter requires actual vendor interface and pilot proof.
