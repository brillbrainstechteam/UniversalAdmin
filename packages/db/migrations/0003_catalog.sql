CREATE TABLE "attribute_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" text[] DEFAULT '{}'::text[] NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribute_definitions_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "attribute_definitions_type_ck" CHECK ("attribute_definitions"."type" in ('text','number','boolean','select'))
);
--> statement-breakpoint
CREATE TABLE "catalog_import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"filename" text NOT NULL,
	"row_count" integer NOT NULL,
	"valid_count" integer NOT NULL,
	"error_count" integer NOT NULL,
	"rows" jsonb NOT NULL,
	"summary" jsonb,
	"created_by" uuid,
	"committed_by" uuid,
	"committed_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_import_batches_status_ck" CHECK ("catalog_import_batches"."status" in ('previewed','committed','discarded'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "categories_parent_ck" CHECK ("categories"."parent_id" is null or "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
CREATE TABLE "channel_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" text NOT NULL,
	"published_at" timestamp (3) with time zone,
	"published_by" uuid,
	"unpublished_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_publications_status_ck" CHECK ("channel_publications"."status" in ('published','unpublished'))
);
--> statement-breakpoint
CREATE TABLE "collection_products" (
	"tenant_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "collection_products_collection_id_product_id_pk" PRIMARY KEY("collection_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "collections_status_ck" CHECK ("collections"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"alt_text" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "media_assets_type_ck" CHECK ("media_assets"."content_type" in ('image/jpeg','image/png','image/webp','image/gif')),
	CONSTRAINT "media_assets_size_ck" CHECK ("media_assets"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_media" (
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_media_product_id_media_id_pk" PRIMARY KEY("product_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"product_type" text DEFAULT 'standard' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"brand" text,
	"category_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seo_title" text,
	"seo_description" text,
	"created_by" uuid,
	"archived_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "products_status_ck" CHECK ("products"."status" in ('draft','active','archived')),
	CONSTRAINT "products_type_ck" CHECK ("products"."product_type" in ('standard','jewellery'))
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_resource_ck" CHECK ("saved_views"."resource" in ('products'))
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"barcode" text,
	"title" text DEFAULT '' NOT NULL,
	"option_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"option_key" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "variants_status_ck" CHECK ("variants"."status" in ('active','inactive')),
	CONSTRAINT "variants_sku_ck" CHECK (length("variants"."sku") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "attribute_definitions" ADD CONSTRAINT "attribute_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_batches" ADD CONSTRAINT "catalog_import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_batches" ADD CONSTRAINT "catalog_import_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import_batches" ADD CONSTRAINT "catalog_import_batches_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_parent_id_categories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_publications" ADD CONSTRAINT "channel_publications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_publications" ADD CONSTRAINT "channel_publications_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_publications" ADD CONSTRAINT "channel_publications_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_publications" ADD CONSTRAINT "channel_publications_tenant_id_channel_id_channels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_products" ADD CONSTRAINT "collection_products_tenant_id_collection_id_collections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","collection_id") REFERENCES "public"."collections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_products" ADD CONSTRAINT "collection_products_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_tenant_id_media_id_media_assets_tenant_id_id_fk" FOREIGN KEY ("tenant_id","media_id") REFERENCES "public"."media_assets"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_category_id_categories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_definitions_tenant_key_uq" ON "attribute_definitions" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "catalog_import_batches_tenant_idx" ON "catalog_import_batches" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "categories_tenant_slug_uq" ON "categories" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_publications_product_channel_uq" ON "channel_publications" USING btree ("product_id","channel_id");--> statement-breakpoint
CREATE INDEX "channel_publications_channel_idx" ON "channel_publications" USING btree ("tenant_id","channel_id","status");--> statement-breakpoint
CREATE INDEX "collection_products_product_idx" ON "collection_products" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collections_tenant_slug_uq" ON "collections" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_storage_key_uq" ON "media_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "product_media_media_idx" ON "product_media" USING btree ("tenant_id","media_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_tenant_slug_uq" ON "products" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX "products_tenant_status_idx" ON "products" USING btree ("tenant_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "products_title_trgm_idx" ON "products" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_owner_name_uq" ON "saved_views" USING btree ("tenant_id","user_id","resource","name");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_tenant_sku_uq" ON "variants" USING btree ("tenant_id",lower("sku"));--> statement-breakpoint
CREATE UNIQUE INDEX "variants_tenant_barcode_uq" ON "variants" USING btree ("tenant_id","barcode") WHERE "variants"."barcode" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "variants_product_option_key_uq" ON "variants" USING btree ("product_id","option_key");--> statement-breakpoint
CREATE INDEX "variants_sku_trgm_idx" ON "variants" USING gin ("sku" gin_trgm_ops);