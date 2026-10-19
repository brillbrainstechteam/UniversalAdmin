CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"gstin" text,
	"status" text DEFAULT 'active' NOT NULL,
	"payment_terms" text DEFAULT 'on_account' NOT NULL,
	"currency" text NOT NULL,
	"credit_limit_minor" bigint,
	"min_order_minor" bigint,
	"accounting_authority" text DEFAULT 'commerce' NOT NULL,
	"sales_rep_user_id" uuid,
	"price_book_id" uuid,
	"catalog_mode" text DEFAULT 'all' NOT NULL,
	"collection_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"notes" text,
	"created_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "companies_status_ck" CHECK ("companies"."status" in ('active','on_hold','inactive')),
	CONSTRAINT "companies_terms_ck" CHECK ("companies"."payment_terms" in ('prepaid','on_account')),
	CONSTRAINT "companies_limits_ck" CHECK (coalesce("companies"."credit_limit_minor", 0) >= 0 and coalesce("companies"."min_order_minor", 0) >= 0),
	CONSTRAINT "companies_gstin_ck" CHECK ("companies"."gstin" is null or "companies"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
);
--> statement-breakpoint
CREATE TABLE "company_buyers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"location_ids" uuid[],
	"order_limit_minor" bigint,
	"status" text DEFAULT 'invited' NOT NULL,
	"invitation_token_hash" text,
	"invitation_expires_at" timestamp (3) with time zone,
	"invited_by" uuid,
	"accepted_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_buyers_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "company_buyers_email_ck" CHECK ("company_buyers"."email" = lower("company_buyers"."email")),
	CONSTRAINT "company_buyers_role_ck" CHECK ("company_buyers"."role" in ('buyer','approver','admin')),
	CONSTRAINT "company_buyers_status_ck" CHECK ("company_buyers"."status" in ('invited','active','disabled')),
	CONSTRAINT "company_buyers_active_user_ck" CHECK ("company_buyers"."status" = 'invited' or "company_buyers"."user_id" is not null),
	CONSTRAINT "company_buyers_limit_ck" CHECK (coalesce("company_buyers"."order_limit_minor", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "company_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_locations_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "credit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"reference" text,
	"order_id" uuid,
	"note" text,
	"actor_user_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_entries_type_ck" CHECK ("credit_entries"."type" in ('order_charge','order_release','payment','advance','adjustment')),
	CONSTRAINT "credit_entries_sign_ck" CHECK (("credit_entries"."type" in ('order_charge') and "credit_entries"."amount_minor" > 0) or ("credit_entries"."type" in ('order_release','payment','advance') and "credit_entries"."amount_minor" < 0) or ("credit_entries"."type" = 'adjustment' and "credit_entries"."amount_minor" <> 0))
);
--> statement-breakpoint
CREATE TABLE "rfq_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"author" text NOT NULL,
	"author_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfq_messages_author_ck" CHECK ("rfq_messages"."author" in ('buyer','staff'))
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"company_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"location_id" uuid,
	"lines" jsonb NOT NULL,
	"note" text,
	"needed_by" timestamp (3) with time zone,
	"status" text DEFAULT 'submitted' NOT NULL,
	"quotation_id" uuid,
	"decline_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfqs_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "rfqs_status_ck" CHECK ("rfqs"."status" in ('submitted','quoted','accepted','declined','expired','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_audience_ck";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_ck";--> statement-breakpoint
ALTER TABLE "price_list_entries" ADD COLUMN "min_quantity" integer;--> statement-breakpoint
ALTER TABLE "order_settings" ADD COLUMN "rfq_prefix" text DEFAULT 'RFQ' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_settings" ADD COLUMN "next_rfq_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "company_location_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "po_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_approved_by" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_approved_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_approval_note" text;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "quotations" ADD COLUMN "rfq_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_sales_rep_user_id_users_id_fk" FOREIGN KEY ("sales_rep_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_price_book_id_price_books_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_book_id") REFERENCES "public"."price_books"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_buyers" ADD CONSTRAINT "company_buyers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_buyers" ADD CONSTRAINT "company_buyers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_buyers" ADD CONSTRAINT "company_buyers_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_buyers" ADD CONSTRAINT "company_buyers_tenant_id_company_id_companies_tenant_id_id_fk" FOREIGN KEY ("tenant_id","company_id") REFERENCES "public"."companies"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_locations" ADD CONSTRAINT "company_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_locations" ADD CONSTRAINT "company_locations_tenant_id_company_id_companies_tenant_id_id_fk" FOREIGN KEY ("tenant_id","company_id") REFERENCES "public"."companies"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_tenant_id_company_id_companies_tenant_id_id_fk" FOREIGN KEY ("tenant_id","company_id") REFERENCES "public"."companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_tenant_id_order_id_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_messages" ADD CONSTRAINT "rfq_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_messages" ADD CONSTRAINT "rfq_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_messages" ADD CONSTRAINT "rfq_messages_tenant_id_rfq_id_rfqs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","rfq_id") REFERENCES "public"."rfqs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_tenant_id_company_id_companies_tenant_id_id_fk" FOREIGN KEY ("tenant_id","company_id") REFERENCES "public"."companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_tenant_id_buyer_id_company_buyers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","buyer_id") REFERENCES "public"."company_buyers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_tenant_id_location_id_company_locations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."company_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_tenant_code_uq" ON "companies" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "company_buyers_company_email_uq" ON "company_buyers" USING btree ("company_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "company_buyers_company_user_uq" ON "company_buyers" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_buyers_invitation_uq" ON "company_buyers" USING btree ("invitation_token_hash");--> statement-breakpoint
CREATE INDEX "company_buyers_user_idx" ON "company_buyers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "company_locations_code_uq" ON "company_locations" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "credit_entries_company_idx" ON "credit_entries" USING btree ("company_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "credit_entries_order_type_uq" ON "credit_entries" USING btree ("order_id","type") WHERE "credit_entries"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "rfq_messages_rfq_idx" ON "rfq_messages" USING btree ("rfq_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rfqs_tenant_number_uq" ON "rfqs" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "rfqs_company_idx" ON "rfqs" USING btree ("company_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_approved_by_users_id_fk" FOREIGN KEY ("buyer_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_company_idx" ON "orders" USING btree ("company_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_audience_ck" CHECK ("sessions"."audience" in ('merchant','platform','buyer'));--> statement-breakpoint
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_moq_ck" CHECK ("price_list_entries"."min_quantity" is null or "price_list_entries"."min_quantity" > 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_ck" CHECK ("orders"."status" in ('awaiting_buyer_approval','awaiting_approval','pending_payment','confirmed','on_hold','cancelled'));