# 04 Jewellery-specific pricing and measurement specification
## Measurement contract
Support gross_g, net_g, fine_g, stone_g, carat, integer pcs, quantity decimal with declared unit, pairs/sets and configurable per-product billable measure. Gross must not be blindly overwritten as net+stone; configurable material/component accounting. Preserve vendor raw fields and transformed values. Validation: non-negative, precision and merchant-specific tolerance, net <= gross unless an explicit reviewed exception; fine weight calculation requires a defined purity formula and input provenance. Multi-metal/component pieces require per-component breakdown.

## Pricing DSL (non-executable data)
Versioned JSON rules with conditions company/channel/category/metal/purity/location/effective interval; component operations e.g. metal value = chosen weight * quoted rate, making = per gram/per piece/%/fixed/tier, wastage under approved explicit basis, gemstone line-items, labour, hallmark/certificate, packing, discount allocation and tax rule. Explain calculations with exact intermediate decimal values and defined rounding stage. Price book precedence and conflict detection; QA snapshot fixtures.

## Rate governance
Provider adapter must specify credentials/ref, contract/licensing, currency, metal/purity and unit/market; refreshed_at/source_as_of/effective_at; manual override reason and approval; rate staleness threshold and fallback block/use last approved/manual with visible provenance, approval rules and audit. Never present illustrative rate as live. Publish version, subscribe price cache invalidation, retain historical values. Rate lock policy checkout TTL/confirm/payment/dispatch/manual per contract. An accepted quote retains terms until expiry but fulfillment-date pricing can be explicitly defined if customer accepts it.

## Order calculation example (illustrative only, no live price)
Line: metal = applicable billable metal_g × purity-specific rate in INR/g; making = configured mode; stone = sum individually; other charges; discount applied to eligible components; tax engine given correct taxable categories and taxable base; total = rounded sum per approved commercial/tax policy. Validate no doubles on wastage or tax-included prices. OrderSnapshot holds source metal rate IDs, formula revision, precise inputs, component-level totals and buyer acknowledgment of reprice.

## B2B cases
GWT or NWT billing by article/aggregate, QTY numeric plus PCS integer, min-order grams/pieces/value, customer-specific book, per-gram/pcs making, quotation vs fixed rate, partial acceptance, deposit/credit exposures, advance/payment allocation, metal provided by customer and settlement if enabled. Order lines always retain displayed count and billable amount separately.

## B2C cases
Serialized unique weight per available article; item-specific product detail page/price or declared indicative-from price if variable; checkout selects actual item and locks/reserves it; custom/made-to-order estimated final weight requires buyer approval of final payable policy. Returns/refunds reflect captured historic price rather than current spot rate unless agreed contract states otherwise.
