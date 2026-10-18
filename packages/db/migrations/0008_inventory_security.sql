-- Phase 04: tenant isolation for inventory tables (ADR-002); the stock ledger is append-only like the audit log;
-- new inventory.reserve permission for existing system roles; default stock settings for existing tenants.
ALTER TABLE stock_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_settings_tenant_isolation ON stock_settings USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE variant_stock_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY variant_stock_settings_tenant_isolation ON variant_stock_settings USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE channel_stock_locations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY channel_stock_locations_tenant_isolation ON channel_stock_locations USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE stock_balances ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_balances_tenant_isolation ON stock_balances USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_movements_tenant_isolation ON stock_movements USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY reservations_tenant_isolation ON reservations USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE transfers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY transfers_tenant_isolation ON transfers USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE transfer_lines ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY transfer_lines_tenant_isolation ON transfer_lines USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_counts_tenant_isolation ON stock_counts USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE stock_count_lines ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_count_lines_tenant_isolation ON stock_count_lines USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE stock_documents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_documents_tenant_isolation ON stock_documents USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE reconciliation_issues ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY reconciliation_issues_tenant_isolation ON reconciliation_issues USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON stock_movements FROM uc_app;--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['inventory.reserve']) ORDER BY 1), version = version + 1 WHERE is_system AND key IN ('owner','admin','inventory_operator','sales_rep');--> statement-breakpoint
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['inventory.read']) ORDER BY 1), version = version + 1 WHERE is_system AND key = 'sales_rep';--> statement-breakpoint
INSERT INTO stock_settings (tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;
