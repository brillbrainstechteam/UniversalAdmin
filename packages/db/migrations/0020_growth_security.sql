-- Phase 10: tenant isolation for online-store, discount and marketing tables (ADR-002); published content versions and discount redemptions are immutable (ADR-025).
ALTER TABLE site_documents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_documents_tenant_isolation ON site_documents USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE site_document_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_document_versions_tenant_isolation ON site_document_versions USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE redirects ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY redirects_tenant_isolation ON redirects USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE segments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY segments_tenant_isolation ON segments USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE discounts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY discounts_tenant_isolation ON discounts USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE discount_redemptions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY discount_redemptions_tenant_isolation ON discount_redemptions USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY campaigns_tenant_isolation ON campaigns USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY campaign_recipients_tenant_isolation ON campaign_recipients USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON site_document_versions, discount_redemptions FROM uc_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON site_documents, discounts, campaigns FROM uc_app;--> statement-breakpoint
CREATE TRIGGER site_document_versions_append_only BEFORE UPDATE OR DELETE ON site_document_versions
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
CREATE TRIGGER discount_redemptions_append_only BEFORE UPDATE OR DELETE ON discount_redemptions
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();
