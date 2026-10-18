-- Catalog tables: tenant isolation (same predicate as 0001, ADR-002). Grants come from default privileges.
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY categories_tenant_isolation ON categories USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE attribute_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY attribute_definitions_tenant_isolation ON attribute_definitions USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE products ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY products_tenant_isolation ON products USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE variants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY variants_tenant_isolation ON variants USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY collections_tenant_isolation ON collections USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE collection_products ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY collection_products_tenant_isolation ON collection_products USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY media_assets_tenant_isolation ON media_assets USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE product_media ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY product_media_tenant_isolation ON product_media USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE channel_publications ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY channel_publications_tenant_isolation ON channel_publications USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY saved_views_tenant_isolation ON saved_views USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));--> statement-breakpoint
ALTER TABLE catalog_import_batches ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY catalog_import_batches_tenant_isolation ON catalog_import_batches USING (uc_tenant_visible(tenant_id)) WITH CHECK (uc_tenant_visible(tenant_id));
