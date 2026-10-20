CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'not_sent' NOT NULL,
	"status_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_recipients_status_ck" CHECK ("campaign_recipients"."status" in ('not_sent','sent','failed'))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"segment_id" uuid NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"prepared_at" timestamp (3) with time zone,
	"prepared_by" uuid,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"excluded_no_consent" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "campaigns_channel_ck" CHECK ("campaigns"."channel" in ('email','sms','whatsapp')),
	CONSTRAINT "campaigns_status_ck" CHECK ("campaigns"."status" in ('draft','prepared'))
);
--> statement-breakpoint
CREATE TABLE "discount_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"discount_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"code" text,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_redemptions_amount_ck" CHECK ("discount_redemptions"."amount_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"mode" text NOT NULL,
	"value" numeric(20, 6) NOT NULL,
	"currency" text,
	"min_subtotal_minor" bigint,
	"starts_at" timestamp (3) with time zone NOT NULL,
	"ends_at" timestamp (3) with time zone,
	"usage_limit" integer,
	"per_customer_limit" integer,
	"segment_id" uuid,
	"channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"combinable" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discounts_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "discounts_mode_ck" CHECK ("discounts"."mode" in ('percent','fixed')),
	CONSTRAINT "discounts_value_ck" CHECK ("discounts"."value" > 0 and ("discounts"."mode" <> 'percent' or "discounts"."value" <= 100)),
	CONSTRAINT "discounts_currency_ck" CHECK ("discounts"."mode" <> 'fixed' or "discounts"."currency" is not null),
	CONSTRAINT "discounts_code_ck" CHECK ("discounts"."code" is null or "discounts"."code" ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
	CONSTRAINT "discounts_window_ck" CHECK ("discounts"."ends_at" is null or "discounts"."ends_at" > "discounts"."starts_at"),
	CONSTRAINT "discounts_limits_ck" CHECK (coalesce("discounts"."usage_limit", 1) > 0 and coalesce("discounts"."per_customer_limit", 1) > 0),
	CONSTRAINT "discounts_used_ck" CHECK ("discounts"."used_count" >= 0 and ("discounts"."usage_limit" is null or "discounts"."used_count" <= "discounts"."usage_limit"))
);
--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"status_code" integer DEFAULT 301 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_code_ck" CHECK ("redirects"."status_code" in (301, 302)),
	CONSTRAINT "redirects_paths_ck" CHECK ("redirects"."from_path" like '/%' and "redirects"."from_path" <> "redirects"."to_path")
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segments_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "site_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"note" text,
	"published_by" uuid,
	"published_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"draft" jsonb NOT NULL,
	"draft_updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"draft_updated_by" uuid,
	"published" jsonb,
	"published_version" integer,
	"published_at" timestamp (3) with time zone,
	"live" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_documents_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "site_documents_kind_ck" CHECK ("site_documents"."kind" in ('theme','menu','page','banner')),
	CONSTRAINT "site_documents_live_ck" CHECK (not "site_documents"."live" or "site_documents"."published" is not null)
);
--> statement-breakpoint
ALTER TABLE "channel_domains" ADD COLUMN "verification_token" text;--> statement-breakpoint
ALTER TABLE "channel_domains" ADD COLUMN "last_check_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "channel_domains" ADD COLUMN "last_check_error" text;--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "discount_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "attribution" jsonb;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_tenant_id_campaign_id_campaigns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","campaign_id") REFERENCES "public"."campaigns"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_segment_id_segments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","segment_id") REFERENCES "public"."segments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_tenant_id_discount_id_discounts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","discount_id") REFERENCES "public"."discounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_tenant_id_order_id_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_tenant_id_segment_id_segments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","segment_id") REFERENCES "public"."segments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "redirects" ADD CONSTRAINT "redirects_tenant_id_channel_id_channels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segments" ADD CONSTRAINT "segments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_document_versions" ADD CONSTRAINT "site_document_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_document_versions" ADD CONSTRAINT "site_document_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_document_versions" ADD CONSTRAINT "site_document_versions_tenant_id_document_id_site_documents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."site_documents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_documents" ADD CONSTRAINT "site_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_documents" ADD CONSTRAINT "site_documents_draft_updated_by_users_id_fk" FOREIGN KEY ("draft_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_documents" ADD CONSTRAINT "site_documents_tenant_id_channel_id_channels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_uq" ON "campaign_recipients" USING btree ("campaign_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_uq" ON "discount_redemptions" USING btree ("discount_id","order_id");--> statement-breakpoint
CREATE INDEX "discount_redemptions_customer_idx" ON "discount_redemptions" USING btree ("discount_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_code_uq" ON "discounts" USING btree ("tenant_id","code") WHERE "discounts"."code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "redirects_from_uq" ON "redirects" USING btree ("tenant_id","channel_id","from_path");--> statement-breakpoint
CREATE UNIQUE INDEX "segments_name_uq" ON "segments" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "site_document_versions_uq" ON "site_document_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "site_documents_key_uq" ON "site_documents" USING btree ("tenant_id","channel_id","kind","key");