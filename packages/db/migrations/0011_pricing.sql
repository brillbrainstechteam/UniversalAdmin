CREATE TABLE "metal_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"metal" text NOT NULL,
	"purity_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"rate_per_g" numeric(20, 6) NOT NULL,
	"input_value" text NOT NULL,
	"input_unit" text NOT NULL,
	"source_as_of" timestamp (3) with time zone NOT NULL,
	"effective_from" timestamp (3) with time zone,
	"status" text DEFAULT 'proposed' NOT NULL,
	"reason" text,
	"proposed_by" uuid,
	"proposed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp (3) with time zone,
	"decision_note" text,
	"stale_notified_at" timestamp (3) with time zone,
	CONSTRAINT "metal_rates_positive_ck" CHECK ("metal_rates"."rate_per_g" > 0),
	CONSTRAINT "metal_rates_currency_ck" CHECK ("metal_rates"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "metal_rates_status_ck" CHECK ("metal_rates"."status" in ('proposed','approved','rejected')),
	CONSTRAINT "metal_rates_decided_ck" CHECK (("metal_rates"."status" = 'proposed') = ("metal_rates"."decided_at" is null)),
	CONSTRAINT "metal_rates_four_eyes_ck" CHECK ("metal_rates"."decided_by" is null or "metal_rates"."decided_by" <> "metal_rates"."proposed_by"),
	CONSTRAINT "metal_rates_effective_ck" CHECK ("metal_rates"."status" <> 'approved' or "metal_rates"."effective_from" is not null)
);
--> statement-breakpoint
CREATE TABLE "price_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"channel_id" uuid,
	"priority" integer DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"effective_from" timestamp (3) with time zone,
	"effective_to" timestamp (3) with time zone,
	"created_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_books_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_books_currency_ck" CHECK ("price_books"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "price_books_status_ck" CHECK ("price_books"."status" in ('active','archived')),
	CONSTRAINT "price_books_window_ck" CHECK ("price_books"."effective_from" is null or "price_books"."effective_to" is null or "price_books"."effective_to" > "price_books"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "price_list_entries" (
	"tenant_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_entries_book_id_variant_id_pk" PRIMARY KEY("book_id","variant_id"),
	CONSTRAINT "price_list_entries_amount_ck" CHECK ("price_list_entries"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid,
	"origin" text NOT NULL,
	"currency" text NOT NULL,
	"line_inputs" jsonb NOT NULL,
	"lines" jsonb NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"warnings" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"superseded_by" uuid,
	"superseded_at" timestamp (3) with time zone,
	CONSTRAINT "price_quotes_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_quotes_origin_ck" CHECK ("price_quotes"."origin" in ('admin','storefront')),
	CONSTRAINT "price_quotes_expiry_ck" CHECK ("price_quotes"."expires_at" > "price_quotes"."created_at"),
	CONSTRAINT "price_quotes_total_ck" CHECK ("price_quotes"."total_minor" = "price_quotes"."subtotal_minor" - "price_quotes"."discount_minor" + "price_quotes"."tax_minor")
);
--> statement-breakpoint
CREATE TABLE "price_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"priority" integer NOT NULL,
	"conditions" jsonb NOT NULL,
	"definition" jsonb NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_at" timestamp (3) with time zone,
	"lock_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "price_rule_versions_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_rule_versions_status_ck" CHECK ("price_rule_versions"."status" in ('draft','published','superseded','retired')),
	CONSTRAINT "price_rule_versions_published_ck" CHECK ("price_rule_versions"."status" = 'draft' or "price_rule_versions"."published_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "price_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"retire_reason" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp (3) with time zone,
	CONSTRAINT "price_rules_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_rules_status_ck" CHECK ("price_rules"."status" in ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE "pricing_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"quote_ttl_minutes" integer DEFAULT 15 NOT NULL,
	"rate_max_age_minutes" integer DEFAULT 1440 NOT NULL,
	"stale_policy" text DEFAULT 'block' NOT NULL,
	"rule_review_required" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_settings_ttl_ck" CHECK ("pricing_settings"."quote_ttl_minutes" between 1 and 10080),
	CONSTRAINT "pricing_settings_age_ck" CHECK ("pricing_settings"."rate_max_age_minutes" between 1 and 44640),
	CONSTRAINT "pricing_settings_stale_ck" CHECK ("pricing_settings"."stale_policy" in ('block','use_last_approved'))
);
--> statement-breakpoint
CREATE TABLE "rate_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"provider_key" text,
	"status" text DEFAULT 'active' NOT NULL,
	"credential_ref" text,
	"licence_ref" text,
	"adapter_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_pulled_at" timestamp (3) with time zone,
	"created_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_sources_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "rate_sources_kind_ck" CHECK (("rate_sources"."kind" = 'manual') = ("rate_sources"."provider_key" is null)),
	CONSTRAINT "rate_sources_status_ck" CHECK ("rate_sources"."status" in ('active','disabled')),
	CONSTRAINT "rate_sources_credential_ref_ck" CHECK ("rate_sources"."credential_ref" is null or "rate_sources"."credential_ref" ~ '^(vault|env|secretsmanager):')
);
--> statement-breakpoint
CREATE TABLE "tax_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"rate_percent" numeric(7, 4) NOT NULL,
	"applies_to" text[] NOT NULL,
	"status" text DEFAULT 'pending_validation' NOT NULL,
	"validation_note" text,
	"validated_by" uuid,
	"validated_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rules_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_rules_rate_ck" CHECK ("tax_rules"."rate_percent" >= 0 and "tax_rules"."rate_percent" <= 100),
	CONSTRAINT "tax_rules_status_ck" CHECK ("tax_rules"."status" in ('pending_validation','validated','inactive'))
);
--> statement-breakpoint
ALTER TABLE "metal_rates" ADD CONSTRAINT "metal_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metal_rates" ADD CONSTRAINT "metal_rates_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metal_rates" ADD CONSTRAINT "metal_rates_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metal_rates" ADD CONSTRAINT "metal_rates_tenant_id_source_id_rate_sources_tenant_id_id_fk" FOREIGN KEY ("tenant_id","source_id") REFERENCES "public"."rate_sources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metal_rates" ADD CONSTRAINT "metal_rates_tenant_id_purity_id_purity_definitions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","purity_id") REFERENCES "public"."purity_definitions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_books" ADD CONSTRAINT "price_books_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_books" ADD CONSTRAINT "price_books_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_books" ADD CONSTRAINT "price_books_tenant_id_channel_id_channels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_tenant_id_book_id_price_books_tenant_id_id_fk" FOREIGN KEY ("tenant_id","book_id") REFERENCES "public"."price_books"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_tenant_id_channel_id_channels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rule_versions" ADD CONSTRAINT "price_rule_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rule_versions" ADD CONSTRAINT "price_rule_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rule_versions" ADD CONSTRAINT "price_rule_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rule_versions" ADD CONSTRAINT "price_rule_versions_tenant_id_rule_id_price_rules_tenant_id_id_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."price_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_tenant_id_book_id_price_books_tenant_id_id_fk" FOREIGN KEY ("tenant_id","book_id") REFERENCES "public"."price_books"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_settings" ADD CONSTRAINT "pricing_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_sources" ADD CONSTRAINT "rate_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_sources" ADD CONSTRAINT "rate_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_validated_by_users_id_fk" FOREIGN KEY ("validated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "metal_rates_current_idx" ON "metal_rates" USING btree ("tenant_id","purity_id","currency","status","effective_from" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "metal_rates_tenant_proposed_idx" ON "metal_rates" USING btree ("tenant_id","proposed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "price_books_tenant_name_uq" ON "price_books" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "price_quotes_tenant_created_idx" ON "price_quotes" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "price_rule_versions_rule_version_uq" ON "price_rule_versions" USING btree ("rule_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "price_rule_versions_one_draft_uq" ON "price_rule_versions" USING btree ("rule_id") WHERE "price_rule_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "price_rule_versions_one_published_uq" ON "price_rule_versions" USING btree ("rule_id") WHERE "price_rule_versions"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "price_rules_book_name_uq" ON "price_rules" USING btree ("book_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "rate_sources_manual_uq" ON "rate_sources" USING btree ("tenant_id") WHERE "rate_sources"."kind" = 'manual';--> statement-breakpoint
CREATE UNIQUE INDEX "rate_sources_tenant_name_uq" ON "rate_sources" USING btree ("tenant_id",lower("name"));