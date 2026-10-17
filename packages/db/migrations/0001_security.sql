-- Custom migration: runtime role grants, row-level security, append-only audit (ADR-002, ADR-008).
-- Runs as uc_owner. The runtime role uc_app is created by infra/postgres/init.sql (or the CI bootstrap step).
GRANT USAGE ON SCHEMA public TO uc_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO uc_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO uc_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO uc_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO uc_app;--> statement-breakpoint
-- Audit log is append-only for the runtime role, and for everyone via trigger.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM uc_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION uc_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
-- Tenant isolation predicate: transaction-local app.tenant_id, or explicit system bypass (DbService.systemTx).
CREATE OR REPLACE FUNCTION uc_tenant_visible(row_tenant uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on'
      OR (row_tenant IS NOT NULL AND row_tenant = nullif(current_setting('app.tenant_id', true), '')::uuid)
$$;--> statement-breakpoint
ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_entitlements_tenant_isolation ON tenant_entitlements USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stores_tenant_isolation ON stores USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY channels_tenant_isolation ON channels USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE channel_domains ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY channel_domains_tenant_isolation ON channel_domains USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY locations_tenant_isolation ON locations USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY roles_tenant_isolation ON roles USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY memberships_tenant_isolation ON memberships USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY membership_roles_tenant_isolation ON membership_roles USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY invitations_tenant_isolation ON invitations USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY audit_events_tenant_isolation ON audit_events USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY outbox_events_tenant_isolation ON outbox_events USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));
