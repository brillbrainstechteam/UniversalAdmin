# API, event and adapter contracts (implementation starting point)
## API conventions
`/v1/platform/*` privileged; `/v1/admin/*` scoped merchant role; `/v1/storefront/*` resolved validated channel/domain; `/v1/integrations/*` signed connector or privileged merchant. OpenAPI schema, UTC ISO timestamps, decimals serialized as strings and money as `{amountMinor,currency}` (or another documented exact representation), pagination cursor/limit, standardized errors `{code,message,details,correlationId}`; `Idempotency-Key` for mutation creating orders/payment/export/import. Authorization on entity resolution, not simply nav hiding. Deprecation/version policy.

## Resource endpoints (flesh out per phase)
platform tenants/entitlements/usage/connectors; admin dashboard/products/variants/items/categories/collections/media, inventory/balances/movements/reservations/adjustments/locations/reconciliation, companies/company-locations/buyers, customers, rates/sources/overrides/approval, pricing/books/rules/quotes, RFQs/quotes, orders/approvals, payments/allocations/refunds, shipments/returns, campaigns/promotions/reports, CMS/pages/menus/themes/domains, settings/users/roles/audit, integrations/connections/mappings/jobs/error-rows/retries/webhooks; storefront config/catalog/pricing-quotes/carts/checkouts/orders/customer-account/B2B-company catalogs/RFQs. Include permissions/action matrix and example request, response, error for each endpoint.

## Canonical domain events
`ProductPublished`, `InventorySnapshotReceived`, `InventoryMovementRecorded`, `ReservationCreated|Committed|Released|Expired`, `RateProposed|Approved|Published|Stale`, `PriceRulePublished`, `QuoteSent|Accepted|Expired`, `OrderConfirmed|Cancelled`, `OrderExportRequested|Acknowledged|Failed`, `PaymentAuthorized|Captured|Failed|Refunded`, `ShipmentDispatched|Delivered`, `ReturnApproved`, `SyncJobCompleted|Failed`, `ReconciliationIssueOpened|Resolved`. Standard envelope `{eventId,eventType,eventVersion,tenantId,aggregateType,aggregateId,aggregateVersion,occurredAt,correlationId,causationId,payload}`. Schema version, idempotent consumers and replay handling.

## Example shapes (illustrative, not exhaustive)
```json
{
  "billingMeasurement": {"basis":"GROSS_WEIGHT","weightGrams":"245.730000","pieces":10,"quantity":"245.730000","quantityUnit":"G"},
  "rateReference":{"metal":"SILVER","purity":"999","rateId":"uuid","unit":"INR_PER_GRAM"},
  "commercialSnapshot":{"ruleVersion":3,"rateId":"uuid","componentBreakdown":[],"currency":"INR","totalMinor":"0"}
}
```
`totalMinor` here is a placeholder in a schema illustration, not a real calculated total. Never infer it from client. Monetary unit semantics must be consistent across API.

## ERP adapter capability shape
```json
{"connectorKey":"vendor-edition-version","capabilities":{"productRead":true,"stockRead":true,"rateRead":false,"orderWrite":false,"stockHoldWrite":false,"webhooks":false,"fileImport":true},"syncMode":"file","stockGranularity":"variant_location","authorities":{"sku":"ERP","stock":"ERP","media":"COMMERCE"}}
```
Never set capability true without implemented and verified behavior.
