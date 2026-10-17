# 00 Product and scope
## Mission
A merchant can provision a branded independent B2B/B2C website on common commerce APIs, connect an authorized ERP or upload inventory, assign field ownership, configure billing/metal rates, and reliably sell without double entry. Platform operator manages tenants, plans, feature flags, monitoring. General-commerce profile must function with jewellery extension switched off.

## Personas
Platform owner/support; merchant owner/admin; B2B sales rep; inventory operator; rate approver; accountant; fulfillment operator; marketer; B2B company buyer/approver; B2C customer; developer/integration maintainer. A user may belong to multiple tenants but every action resolves explicit tenant+role+scope.

## Merchant profiles
B2B jewellery: company accounts/branches/buyers, restricted catalog/price book, RFQ/quote/negotiation, weight/pcs billing, credit/advance, partial dispatch, ERP as authority as configured. B2C jewellery: retail catalog, personalization, cart/checkout/payments, delivery/returns and service. Hybrid: two channels, coordinated inventory reservations and distinct policies. General: no mandatory jewellery fields; piece/standard SKU commerce.

## MVP outcome
One connector simulator + robust CSV mapping/import, one real vendor integration only after credential/docs validated; product and serial item import; configurable metal rates/manual entry; real pricing quote; B2B quotation-to-order and B2C cart-to-order with mock payment adapter distinctly labeled sandbox; reservation and order-outbox; admin operational views; second tenant isolation test.

## Out of scope for MVP (architect for later)
Native complete accounting ledger, automatic legal certification, full ERP vendor parity without access, POS hardware, international multi-jurisdiction tax automation, real-time supplier feed without license, marketplace app store, AI-autonomous financial approval. No unsupported integration advertised.

## KPIs
Time to provision tenant and storefront; % mapped products; stock discrepancy count/age; order export success and lag; stock freshness; checkout price mismatch; duplicate orders zero; unauthorized cross-tenant access zero; quote-to-order conversion; sync repair time. Targets determined by pilot baseline, not invented.

## Roles and major permissions
Super-admin: platform tenants/config/health but audited privileged access to merchant data. Merchant owner: merchant business settings and staff. Catalog editor: content (not ERP-authoritative fields). Inventory operator: validated adjustments within scope. Rate editor: draft; rate approver: approve/publish; sales rep: assigned companies/quotes/orders; accountant: invoice/payment reconciliation; fulfillment: pick/pack/ship. B2B buyer: own company's authorized locations, catalogs, orders; buyer approver: approve. B2C shopper: own account. Fine-grained permissions including location and company scoping; separation-of-duties on sensitive operations.

## UX principles
Shopify-inspired usability, not copied proprietary UI. Left nav Home, Orders, Products, Inventory, Customers/Companies, Pricing & Metal Rates, Marketing, Discounts, Analytics, Online Store, Channels, Integrations, Automations, Audit, Settings. Visible B2B/B2C presets with feature gating; search/filter/paginated tables, detail pages, bulk workflows, saved views, guided setup, confirmation for destructive actions, meaningful error states. Mobile-responsive merchant admin; desktop-first complex mapping screens.
