-- Phase 08: tenant isolation for B2B tables (ADR-002), append-only credit ledger and RFQ thread, tenant-safe links from orders/quotations (ADR-023).
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY companies_tenant_isolation ON companies USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE company_locations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_locations_tenant_isolation ON company_locations USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE company_buyers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY company_buyers_tenant_isolation ON company_buyers USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE credit_entries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY credit_entries_tenant_isolation ON credit_entries USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE rfqs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY rfqs_tenant_isolation ON rfqs USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE rfq_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY rfq_messages_tenant_isolation ON rfq_messages USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON credit_entries, rfq_messages FROM uc_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON companies, rfqs FROM uc_app;--> statement-breakpoint
CREATE TRIGGER credit_entries_append_only BEFORE UPDATE OR DELETE ON credit_entries
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
CREATE TRIGGER rfq_messages_append_only BEFORE UPDATE OR DELETE ON rfq_messages
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id);--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_company_location_fk FOREIGN KEY (tenant_id, company_location_id) REFERENCES company_locations (tenant_id, id);--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_buyer_fk FOREIGN KEY (tenant_id, buyer_id) REFERENCES company_buyers (tenant_id, id);--> statement-breakpoint
ALTER TABLE quotations ADD CONSTRAINT quotations_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES companies (tenant_id, id);--> statement-breakpoint
ALTER TABLE quotations ADD CONSTRAINT quotations_rfq_fk FOREIGN KEY (tenant_id, rfq_id) REFERENCES rfqs (tenant_id, id);--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_company_location_ck CHECK (company_location_id IS NULL OR company_id IS NOT NULL);
