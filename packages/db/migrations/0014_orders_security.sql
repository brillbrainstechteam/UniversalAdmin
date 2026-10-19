-- Phase 07: tenant isolation for order tables (ADR-002), immutable order lines and totals, append-only order timeline (ADR-022).
ALTER TABLE order_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY order_settings_tenant_isolation ON order_settings USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY carts_tenant_isolation ON carts USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY orders_tenant_isolation ON orders USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY order_lines_tenant_isolation ON order_lines USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY order_events_tenant_isolation ON order_events USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payments_tenant_isolation ON payments USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY quotations_tenant_isolation ON quotations USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON order_lines, order_events FROM uc_app;--> statement-breakpoint
GRANT UPDATE (reservation_id) ON order_lines TO uc_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON orders, payments, payment_events, quotations FROM uc_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION uc_order_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order lines are immutable' USING ERRCODE = 'check_violation';
  END IF;
  -- Only the stock hold may be re-pointed (an expired hold re-reserved at payment time); the price never changes.
  IF (to_jsonb(NEW) - 'reservation_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reservation_id') THEN
    RAISE EXCEPTION 'order lines are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER order_lines_guard BEFORE UPDATE OR DELETE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION uc_order_lines_guard();--> statement-breakpoint
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION uc_reject_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION uc_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.number, NEW.origin, NEW.currency, NEW.subtotal_minor, NEW.discount_minor, NEW.tax_minor,
      NEW.total_minor, NEW.price_quote_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.number, OLD.origin, OLD.currency, OLD.subtotal_minor, OLD.discount_minor, OLD.tax_minor,
      OLD.total_minor, OLD.price_quote_id, OLD.created_at) THEN
    RAISE EXCEPTION 'order totals and identity are immutable; record an adjustment instead' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'a cancelled order cannot be reopened' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER orders_guard BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION uc_orders_guard();--> statement-breakpoint
INSERT INTO order_settings (tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;
