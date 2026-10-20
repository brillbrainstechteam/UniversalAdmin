-- Phase 11: tenant isolation for webhook, automation, notification and API key tables (ADR-002); automation run log append-only; new operations permissions for existing system roles (ADR-026).
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY webhook_endpoints_tenant_isolation ON webhook_endpoints USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY webhook_deliveries_tenant_isolation ON webhook_deliveries USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY automations_tenant_isolation ON automations USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY automation_runs_tenant_isolation ON automation_runs USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE staff_notifications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY staff_notifications_tenant_isolation ON staff_notifications USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY api_keys_tenant_isolation ON api_keys USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON automation_runs FROM uc_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON api_keys, webhook_deliveries FROM uc_app;--> statement-breakpoint
CREATE TRIGGER automation_runs_append_only BEFORE UPDATE OR DELETE ON automation_runs
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['apikeys.manage','webhooks.manage','operations.read']) ORDER BY 1), version = version + 1 WHERE is_system AND key IN ('owner','admin');--> statement-breakpoint
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['operations.read']) ORDER BY 1), version = version + 1 WHERE is_system AND key = 'viewer';
