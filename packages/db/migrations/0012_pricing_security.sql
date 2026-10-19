-- Phase 06: tenant isolation for pricing tables (ADR-002) and immutability of rates, published rule versions and quotes (ADR-021).
ALTER TABLE pricing_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY pricing_settings_tenant_isolation ON pricing_settings USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE rate_sources ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY rate_sources_tenant_isolation ON rate_sources USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE metal_rates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY metal_rates_tenant_isolation ON metal_rates USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE tax_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tax_rules_tenant_isolation ON tax_rules USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE price_books ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY price_books_tenant_isolation ON price_books USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE price_list_entries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY price_list_entries_tenant_isolation ON price_list_entries USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE price_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY price_rules_tenant_isolation ON price_rules USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE price_rule_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY price_rule_versions_tenant_isolation ON price_rule_versions USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE price_quotes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY price_quotes_tenant_isolation ON price_quotes USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON metal_rates, price_rule_versions, price_quotes FROM uc_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION uc_metal_rates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.source_id, NEW.metal, NEW.purity_id, NEW.currency, NEW.rate_per_g, NEW.input_value, NEW.input_unit,
      NEW.source_as_of, NEW.reason, NEW.proposed_by, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.source_id, OLD.metal, OLD.purity_id, OLD.currency, OLD.rate_per_g, OLD.input_value, OLD.input_unit,
      OLD.source_as_of, OLD.reason, OLD.proposed_by, OLD.proposed_at) THEN
    RAISE EXCEPTION 'metal rate values are immutable; propose a new rate instead' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'proposed' AND (NEW.status, NEW.decided_by, NEW.decided_at, NEW.decision_note, NEW.effective_from)
     IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decided_at, OLD.decision_note, OLD.effective_from) THEN
    RAISE EXCEPTION 'a decided metal rate cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.effective_from IS NOT NULL AND NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'the requested effective time cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER metal_rates_guard BEFORE UPDATE ON metal_rates FOR EACH ROW EXECUTE FUNCTION uc_metal_rates_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION uc_price_rule_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF (NEW.tenant_id, NEW.rule_id, NEW.version, NEW.priority, NEW.conditions, NEW.definition, NEW.notes, NEW.created_by,
        NEW.created_at, NEW.published_by, NEW.published_at, NEW.lock_version)
       IS DISTINCT FROM
       (OLD.tenant_id, OLD.rule_id, OLD.version, OLD.priority, OLD.conditions, OLD.definition, OLD.notes, OLD.created_by,
        OLD.created_at, OLD.published_by, OLD.published_at, OLD.lock_version) THEN
      RAISE EXCEPTION 'published rule versions are immutable; save a new draft' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (OLD.status = 'published' AND NEW.status IN ('superseded', 'retired')) THEN
      RAISE EXCEPTION 'invalid rule version transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER price_rule_versions_guard BEFORE UPDATE ON price_rule_versions FOR EACH ROW EXECUTE FUNCTION uc_price_rule_versions_guard();--> statement-breakpoint
CREATE OR REPLACE FUNCTION uc_price_quotes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'superseded_by' - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_by' - 'superseded_at')
     OR OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'quotes are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER price_quotes_guard BEFORE UPDATE ON price_quotes FOR EACH ROW EXECUTE FUNCTION uc_price_quotes_guard();--> statement-breakpoint
INSERT INTO pricing_settings (tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO rate_sources (tenant_id, name, kind) SELECT id, 'Manual entry', 'manual' FROM tenants ON CONFLICT DO NOTHING;
