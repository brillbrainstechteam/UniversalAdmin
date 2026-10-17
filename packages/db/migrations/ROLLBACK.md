# Migration rollback notes

Drizzle migrations are forward-only. Roll back by applying the inverse SQL below in a new migration
(never edit an applied migration). Always take a backup first.

| Migration | Rollback |
|---|---|
| 0000_init | Destructive: `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` (only valid before go-live) |
| 0001_security | For each table in `RLS_TABLES`: `DROP POLICY <table>_tenant_isolation ON <table>; ALTER TABLE <table> DISABLE ROW LEVEL SECURITY;` then `DROP TRIGGER audit_events_append_only ON audit_events; DROP FUNCTION uc_reject_mutation(); DROP FUNCTION uc_tenant_visible(uuid);`. Re-granting UPDATE/DELETE on `audit_events` is **not** recommended. Application-level tenant filtering remains in place. |
