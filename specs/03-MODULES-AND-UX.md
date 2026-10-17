# 03 Screens and module requirements
Every relevant listing: server-side search/filter/sort/pagination; saved views; bulk action with permissions, export/import where applicable, empty/loading/error/access-denied, timestamps, contextual actions, audit/activity timeline. Every edit: schema validation, optimistic version handling, unsaved-state warning, real API persistence, error and success feedback; accessibility/responsive behavior. Provide detailed per-screen routes, DTO fields, user actions and tests before implementation.

## Platform super admin
Tenant list/create/suspend, merchant onboarding wizard (business profile, contact, country/timezone, domain, feature entitlement, store/channel, staff invite), subscription/usage and plan mapping, connector registry versions/health, aggregate queue/infrastructure health, support impersonation only just-in-time audited with approval and visible indicator, operational audits. No cross-tenant access by default.

## Merchant Home
Revenue/orders/stock/weight indicators by channel and date; pending approvals, low-stock, stale rates, failed sync, payment/fulfillment exceptions, onboarding checklist, drilldowns and quick actions. Metrics real aggregates, display data freshness.

## Orders
All/draft/orders by workflow state; filters by channel/company/rep/date/payment/fulfillment; detail order lines with measurements and price snapshot, timeline, create/edit draft, approve, cancel with reason, fulfillment splitting, returns/exchanges/refunds, export, documents. Enforce transition rules and stock compensating transactions. B2B quote/RFQ and approval workflow, rate lock, credit holds, proforma. Integrate payment and shipping adapters through contracts.

## Products
Product/variant/serialized item pages, category/collection/attribute schemas, media, SEO, channel publication, price preview, bulk CSV with preview; jewellery section metal/purity/gross/net/fine/components/HUID and bills basis; per-item actual weight; multi-asset product manager. Website fields editable independently of ERP-owned measurement/stock fields. General-commerce removes jewellery mandatory fields.

## Inventory
Dashboard ATP by channel/location; stock on-hand/committed/held/damaged/in-transit, movements, reservations, adjustments (reason+permission), branch transfer, low stock, stocktaking, serialized lookup and barcode/QR, ERP sync center and reconciliation dashboard with review/resolve and full history. Never blindly apply mismatches.

## Customers/Companies
Consumer profiles and consent, history, saved addresses, tags/segments, credit/store credit if enabled; B2B company tree, branches, tax IDs, buyers, approval roles, payment terms, credit limits, location catalogs, sales rep assignment, account activation, customer import/dedup. No unauthorized company data leakage.

## Pricing & Rates
Price books by customer/channel/category/date; visual structured formula builder for base metal value, gross/net/fine/pcs billing, making per g/pcs/%/fixed, wastage, stones/labour/other charges, discounts and tax sequence; test calculator and explainable breakdown. Rates sources, last freshness, manual entry, approval, effective scheduling, rollback only by new revision, history; quote validity and lock moment policies. Reject ambiguous units and stale source when no approved fallback.

## Payments / Fulfillment
Gateway adapter registry with sandbox/test, authorizations/captures/refunds/webhook reconciliation, partial/deposit and credit terms; settlement and discrepancies, no storage of card data. Pick-pack-ship, insured value settings, carrier serviceability, labels/tracking, partial dispatch, delivery/return/RTO, shipment history, warehouse source and ERP invoice authority.

## Marketing/Discounts/Analytics
Campaigns & channel attribution, source/UTM, email/WhatsApp/SMS connectors with consent and approved templates, abandoned checkout and lifecycle automations; discounts fixed/percentage/auto/code/min-order/segment/combination restrictions, validity/redemption. Reports: orders/sales/weights by metal/purity, margin assumptions, rate changes, stock aging, reconciliation, company credit/outstanding, conversion, customers/retention, channel and fulfillment; date/channel/location/segment filters, export; defined metric formulas, timestamps, no invented CAC without spend input.

## Online Store/Channels/Apps
Brand settings, domain verification, theme tokens, navigation, pages, banners, redirects, SEO metadata, publication preview/versioning; separate B2B/B2C channel storefront configurations; product eligibility; external POS/exhibition/marketplace orders by adapter. Connectors center: installation, authorization, capability matrix, status, logs, sync schedules, field ownership, retry and unlink safely; webhooks/events, permissions, API keys scoped and rotated.

## Settings / Access / Operations
General entity/contact/location/currency/timezone/language; business preset, units & rounding, rate, catalog, inventory authority and buffer, checkout, tax config/HSN, shipping/insurance, notifications/consent, payment policies, legal/policies, staff roles/approval hierarchy, audit log, backups/integration status. Settings inheritance platform->industry->merchant->channel/location/catalog->authorized override; protected rules cannot be overridden by customer. Audit export and retention. Automation builder only allow listed typed triggers/conditions/actions, guard loops, retry and run logs.

## B2B buyer portal
Company login/invite, authorized location switch, customer catalog, weight/pcs and MOQ display, multi-SKU bulk entry/reorder, RFQ/quote accept within validity, negotiable terms, buyer approval, orders/partial shipments/invoices/outstanding with correct scopes.

## B2C storefront
Product discovery/filter, item measurements and transparent explainable price/time, customizable options, wishlist optional, cart with quote expiry, checkout server reprice + acknowledgment, payment sandbox/production adapter, account/order status, returns and communication preferences. Show freshness or rate-lock policy where relevant.
