-- Phase 09: tenant isolation for B2C tables (ADR-002), append-only consent log and fulfilment lines, tenant-safe customer link on orders (ADR-024).
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customers_tenant_isolation ON customers USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_sessions_tenant_isolation ON customer_sessions USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE customer_addresses ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_addresses_tenant_isolation ON customer_addresses USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY consent_events_tenant_isolation ON consent_events USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY shipments_tenant_isolation ON shipments USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE shipment_lines ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY shipment_lines_tenant_isolation ON shipment_lines USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY returns_tenant_isolation ON returns USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE return_lines ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY return_lines_tenant_isolation ON return_lines USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY refunds_tenant_isolation ON refunds USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE customer_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_messages_tenant_isolation ON customer_messages USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON consent_events, shipment_lines, return_lines FROM uc_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON customers, shipments, returns, refunds, customer_messages FROM uc_app;--> statement-breakpoint
CREATE TRIGGER consent_events_append_only BEFORE UPDATE OR DELETE ON consent_events
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
CREATE TRIGGER shipment_lines_immutable BEFORE UPDATE OR DELETE ON shipment_lines
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
CREATE TRIGGER return_lines_immutable BEFORE UPDATE OR DELETE ON return_lines
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
-- A refund's amount, payment and order never change after it is created.
CREATE OR REPLACE FUNCTION uc_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_minor <> OLD.amount_minor OR NEW.payment_id <> OLD.payment_id OR NEW.order_id <> OLD.order_id
     OR NEW.currency <> OLD.currency OR (OLD.status <> 'pending' AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'refunds are immutable once created (only a pending refund may settle)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER refunds_guard BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION uc_refund_guard();--> statement-breakpoint
UPDATE roles SET permissions = array_remove(permissions, 'customers.read'), version = version + 1 WHERE is_system AND key = 'viewer' AND 'customers.read' = ANY(permissions);--> statement-breakpoint
ALTER TABLE orders ADD CONSTRAINT orders_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id);
