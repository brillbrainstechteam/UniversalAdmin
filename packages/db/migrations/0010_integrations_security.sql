-- Phase 05: tenant isolation for connector tables (ADR-002). Connection secrets are references only (CHECK in 0009).
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY connections_tenant_isolation ON connections USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE field_mappings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY field_mappings_tenant_isolation ON field_mappings USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE sync_jobs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sync_jobs_tenant_isolation ON sync_jobs USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE sync_job_rows ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sync_job_rows_tenant_isolation ON sync_job_rows USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE external_records ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY external_records_tenant_isolation ON external_records USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE sync_checkpoints ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sync_checkpoints_tenant_isolation ON sync_checkpoints USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE outbound_commands ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY outbound_commands_tenant_isolation ON outbound_commands USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE connector_discovery ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY connector_discovery_tenant_isolation ON connector_discovery USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));
