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
