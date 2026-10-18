-- Phase 03: tenant isolation for jewellery tables (ADR-002), permission sync for existing system roles (J-09),
-- default settings and purity definitions for existing tenants (platform defaults — merchants must confirm).
ALTER TABLE jewellery_settings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY jewellery_settings_tenant_isolation ON jewellery_settings USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE purity_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY purity_definitions_tenant_isolation ON purity_definitions USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE jewellery_specs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY jewellery_specs_tenant_isolation ON jewellery_specs USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE serial_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY serial_items_tenant_isolation ON serial_items USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE jewellery_components ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY jewellery_components_tenant_isolation ON jewellery_components USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['jewellery.review']) ORDER BY 1), version = version + 1 WHERE is_system AND key IN ('owner','admin');--> statement-breakpoint
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT unnest(permissions || ARRAY['jewellery.edit']) ORDER BY 1), version = version + 1 WHERE is_system AND key = 'inventory_operator';--> statement-breakpoint
INSERT INTO jewellery_settings (tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO purity_definitions (tenant_id, metal, code, label, fineness, source)
SELECT t.id, d.metal, d.code, d.label, d.fineness, 'platform_default'
FROM tenants t CROSS JOIN (VALUES
  ('gold','24K','24K (999)',0.999000),
  ('gold','22K','22K (916)',0.916000),
  ('gold','18K','18K (750)',0.750000),
  ('gold','14K','14K (585)',0.585000),
  ('silver','999','Fine silver (999)',0.999000),
  ('silver','925','Sterling silver (925)',0.925000),
  ('platinum','950','Platinum (950)',0.950000)
) AS d(metal, code, label, fineness)
ON CONFLICT DO NOTHING;
