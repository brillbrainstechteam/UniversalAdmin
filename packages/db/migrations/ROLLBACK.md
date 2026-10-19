# Migration rollback notes

Drizzle migrations are forward-only. Roll back by applying the inverse SQL below in a new migration
(never edit an applied migration). Always take a backup first.

| Migration | Rollback |
|---|---|
| 0000_init | Destructive: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` (only valid before go-live) |
| 0001_security | For each table in `RLS_TABLES`: `DROP POLICY <table>_tenant_isolation ON <table>; ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;` then `DROP TRIGGER audit_events_append_only ON audit_events; DROP FUNCTION uc_reject_mutation(); DROP FUNCTION uc_tenant_visible(uuid);`. Re-granting UPDATE/DELETE on `audit_events` is **not** recommended. Application-level tenant filtering remains in place. |
| 0002_extensions | `DROP EXTENSION pg_trgm;` only after 0003 is rolled back (indexes depend on it). |
| 0003_catalog | Destructive: drop tables `catalog_import_batches, saved_views, channel_publications, product_media, media_assets, collection_products, collections, variants, products, attribute_definitions, categories` (in that order). Export catalog data first; object-storage media must be removed separately. |
| 0004_catalog_security | Per catalog table: `DROP POLICY <t>_tenant_isolation ON <t>; ALTER TABLE <t> DISABLE ROW LEVEL SECURITY;` |
| 0005_jewellery | Destructive: drop `jewellery_components, serial_items, jewellery_specs, purity_definitions, jewellery_settings` (in that order). Export measurement data first. |
| 0006_jewellery_security | Per jewellery table drop policy + disable RLS; remove `jewellery.review` from owner/admin and `jewellery.edit` from inventory_operator system roles (`array_remove`). Default purities/settings rows may stay. |
| 0007_inventory | Destructive: drop `reconciliation_issues, stock_count_lines, stock_counts, transfer_lines, transfers, reservations, stock_movements, stock_documents, stock_balances, channel_stock_locations, variant_stock_settings, stock_settings`; `ALTER TABLE serial_items DROP COLUMN location_id, DROP COLUMN stock_state`. Export the ledger first — it is the stock audit trail. |
| 0008_inventory_security | Per inventory table drop policy + disable RLS; `DROP TRIGGER stock_movements_append_only ON stock_movements`; remove `inventory.reserve` from system roles and `inventory.read` from `sales_rep` (`array_remove`); `stock_settings` rows go with the 0007 table drop. |
| 0009_integrations | Destructive: drop `outbound_commands, sync_checkpoints, external_records, sync_job_rows, sync_jobs, field_mappings, connector_discovery, connections`. Export `external_records` first: it is the only link between ERP IDs and commerce products (re-imports would otherwise create duplicates). Products, pieces and stock created by imports stay (they are ordinary records with ledger history). |
| 0010_integrations_security | Per integration table drop policy + disable RLS. |
| 0011_pricing | Destructive: drop `price_quotes, price_rule_versions, price_rules, price_list_entries, price_books, tax_rules, metal_rates, rate_sources, pricing_settings` (in that order). Export `metal_rates` and `price_quotes` first: they are the rate approval history and the record of prices shown to customers. |
| 0012_pricing_security | Per pricing table drop policy + disable RLS; `DROP TRIGGER metal_rates_guard ON metal_rates; DROP TRIGGER price_rule_versions_guard ON price_rule_versions; DROP TRIGGER price_quotes_guard ON price_quotes;` then drop functions `uc_metal_rates_guard, uc_price_rule_versions_guard, uc_price_quotes_guard`; `GRANT DELETE ON metal_rates, price_rule_versions, price_quotes TO uc_app` only if immutability is deliberately abandoned. |
| 0013_orders | Destructive: drop `payment_events, payments, order_events, order_lines, quotations, orders, carts, order_settings` (in that order). Export orders, lines (price snapshots) and payments first: they are the commercial record. Release any open holds first (`reservations` with reference_type `checkout`/`order`). |
| 0014_orders_security | Per order table drop policy + disable RLS; `DROP TRIGGER order_lines_guard ON order_lines; DROP FUNCTION uc_order_lines_guard(); DROP TRIGGER order_events_append_only ON order_events; DROP TRIGGER orders_guard ON orders; DROP FUNCTION uc_orders_guard();` Re-granting UPDATE/DELETE on order lines/events is not recommended. |
