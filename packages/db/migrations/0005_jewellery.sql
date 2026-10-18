CREATE TABLE "jewellery_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"spec_id" uuid,
	"item_id" uuid,
	"kind" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"shape" text,
	"grade" text,
	"count" integer DEFAULT 1 NOT NULL,
	"weight_g" numeric(20, 6) NOT NULL,
	"metal" text,
	"purity_id" uuid,
	"certificate" text,
	"position" integer DEFAULT 0 NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "jewellery_components_owner_ck" CHECK (("jewellery_components"."spec_id" is null) <> ("jewellery_components"."item_id" is null)),
	CONSTRAINT "jewellery_components_kind_ck" CHECK ("jewellery_components"."kind" in ('diamond','gemstone','pearl','metal','other')),
	CONSTRAINT "jewellery_components_count_ck" CHECK ("jewellery_components"."count" between 1 and 10000),
	CONSTRAINT "jewellery_components_weight_ck" CHECK ("jewellery_components"."weight_g" >= 0),
	CONSTRAINT "jewellery_components_metal_ck" CHECK (("jewellery_components"."kind" = 'metal') = ("jewellery_components"."purity_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "jewellery_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"weight_tolerance_g" numeric(20, 6) DEFAULT '0.010000' NOT NULL,
	"fine_scale" integer DEFAULT 3 NOT NULL,
	"huid_format" text DEFAULT 'bis_6_alnum' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jewellery_settings_scale_ck" CHECK ("jewellery_settings"."fine_scale" between 0 and 6),
	CONSTRAINT "jewellery_settings_tolerance_ck" CHECK ("jewellery_settings"."weight_tolerance_g" >= 0),
	CONSTRAINT "jewellery_settings_huid_ck" CHECK ("jewellery_settings"."huid_format" in ('bis_6_alnum','free_text'))
);
--> statement-breakpoint
CREATE TABLE "jewellery_specs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"metal" text NOT NULL,
	"purity_id" uuid NOT NULL,
	"colour" text,
	"gross_g" numeric(20, 6),
	"net_g" numeric(20, 6),
	"stone_g" numeric(20, 6),
	"fine_g" numeric(20, 6),
	"fine_source" text,
	"billing_basis" text NOT NULL,
	"qty_unit" text DEFAULT 'piece' NOT NULL,
	"pieces_per_unit" integer DEFAULT 1 NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jewellery_specs_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "jewellery_specs_weights_ck" CHECK (coalesce("jewellery_specs"."gross_g",0) >= 0 and coalesce("jewellery_specs"."net_g",0) >= 0 and coalesce("jewellery_specs"."stone_g",0) >= 0 and coalesce("jewellery_specs"."fine_g",0) >= 0),
	CONSTRAINT "jewellery_specs_basis_ck" CHECK ("jewellery_specs"."billing_basis" in ('gross','net','fine','piece')),
	CONSTRAINT "jewellery_specs_unit_ck" CHECK ("jewellery_specs"."qty_unit" in ('piece','pair','set')),
	CONSTRAINT "jewellery_specs_pieces_ck" CHECK ("jewellery_specs"."pieces_per_unit" between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "purity_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metal" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"fineness" numeric(7, 6) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'merchant' NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purity_definitions_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "purity_definitions_fineness_ck" CHECK ("purity_definitions"."fineness" > 0 and "purity_definitions"."fineness" <= 1),
	CONSTRAINT "purity_definitions_metal_ck" CHECK ("purity_definitions"."metal" in ('gold','silver','platinum','palladium','other')),
	CONSTRAINT "purity_definitions_status_ck" CHECK ("purity_definitions"."status" in ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE "serial_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"serial_tag" text NOT NULL,
	"huid" text,
	"metal" text NOT NULL,
	"purity_id" uuid NOT NULL,
	"gross_g" numeric(20, 6) NOT NULL,
	"net_g" numeric(20, 6) NOT NULL,
	"stone_g" numeric(20, 6) DEFAULT '0' NOT NULL,
	"fine_g" numeric(20, 6) NOT NULL,
	"fine_source" text NOT NULL,
	"fine_formula" jsonb,
	"pieces" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"weight_exception_reason" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp (3) with time zone,
	"review_note" text,
	"certificates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "serial_items_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "serial_items_weights_ck" CHECK ("serial_items"."gross_g" >= 0 and "serial_items"."net_g" >= 0 and "serial_items"."stone_g" >= 0 and "serial_items"."fine_g" >= 0),
	CONSTRAINT "serial_items_net_gross_ck" CHECK ("serial_items"."net_g" <= "serial_items"."gross_g" or "serial_items"."weight_exception_reason" is not null),
	CONSTRAINT "serial_items_pieces_ck" CHECK ("serial_items"."pieces" between 1 and 1000),
	CONSTRAINT "serial_items_status_ck" CHECK ("serial_items"."status" in ('pending_review','active','retired')),
	CONSTRAINT "serial_items_huid_upper_ck" CHECK ("serial_items"."huid" is null or "serial_items"."huid" = upper("serial_items"."huid"))
);
--> statement-breakpoint
ALTER TABLE "jewellery_components" ADD CONSTRAINT "jewellery_components_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jewellery_components" ADD CONSTRAINT "jewellery_components_tenant_id_spec_id_jewellery_specs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","spec_id") REFERENCES "public"."jewellery_specs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jewellery_components" ADD CONSTRAINT "jewellery_components_tenant_id_item_id_serial_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."serial_items"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jewellery_components" ADD CONSTRAINT "jewellery_components_tenant_id_purity_id_purity_definitions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","purity_id") REFERENCES "public"."purity_definitions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jewellery_settings" ADD CONSTRAINT "jewellery_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jewellery_specs" ADD CONSTRAINT "jewellery_specs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jewellery_specs" ADD CONSTRAINT "jewellery_specs_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jewellery_specs" ADD CONSTRAINT "jewellery_specs_tenant_id_purity_id_purity_definitions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","purity_id") REFERENCES "public"."purity_definitions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purity_definitions" ADD CONSTRAINT "purity_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purity_definitions" ADD CONSTRAINT "purity_definitions_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_items" ADD CONSTRAINT "serial_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_items" ADD CONSTRAINT "serial_items_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_items" ADD CONSTRAINT "serial_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_items" ADD CONSTRAINT "serial_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_items" ADD CONSTRAINT "serial_items_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_items" ADD CONSTRAINT "serial_items_tenant_id_purity_id_purity_definitions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","purity_id") REFERENCES "public"."purity_definitions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jewellery_components_spec_idx" ON "jewellery_components" USING btree ("spec_id");--> statement-breakpoint
CREATE INDEX "jewellery_components_item_idx" ON "jewellery_components" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jewellery_specs_variant_uq" ON "jewellery_specs" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purity_definitions_tenant_code_uq" ON "purity_definitions" USING btree ("tenant_id","metal","code");--> statement-breakpoint
CREATE UNIQUE INDEX "serial_items_tenant_tag_uq" ON "serial_items" USING btree ("tenant_id",lower("serial_tag"));--> statement-breakpoint
CREATE UNIQUE INDEX "serial_items_tenant_huid_uq" ON "serial_items" USING btree ("tenant_id","huid") WHERE "serial_items"."huid" is not null;--> statement-breakpoint
CREATE INDEX "serial_items_variant_idx" ON "serial_items" USING btree ("tenant_id","variant_id");