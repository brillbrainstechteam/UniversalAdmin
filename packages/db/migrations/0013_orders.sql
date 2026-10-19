CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"lines" jsonb NOT NULL,
	"order_id" uuid,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carts_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "carts_status_ck" CHECK ("carts"."status" in ('open','converted','abandoned'))
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "order_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_user_id" uuid,
	"note" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"serial_item_id" uuid,
	"sku" text NOT NULL,
	"title" text NOT NULL,
	"serial_tag" text,
	"quantity" integer NOT NULL,
	"total_minor" bigint NOT NULL,
	"price_snapshot" jsonb NOT NULL,
	"reservation_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_quantity_ck" CHECK ("order_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"approval_threshold_minor" bigint,
	"checkout_hold_minutes" integer DEFAULT 30 NOT NULL,
	"quotation_max_days" integer DEFAULT 7 NOT NULL,
	"order_prefix" text DEFAULT 'ORD' NOT NULL,
	"quotation_prefix" text DEFAULT 'QUO' NOT NULL,
	"next_order_number" integer DEFAULT 1 NOT NULL,
	"next_quotation_number" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_settings_hold_ck" CHECK ("order_settings"."checkout_hold_minutes" between 5 and 1440),
	CONSTRAINT "order_settings_quotation_days_ck" CHECK ("order_settings"."quotation_max_days" between 1 and 90),
	CONSTRAINT "order_settings_threshold_ck" CHECK ("order_settings"."approval_threshold_minor" is null or "order_settings"."approval_threshold_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"channel_id" uuid,
	"origin" text NOT NULL,
	"status" text NOT NULL,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"payment_terms" text NOT NULL,
	"currency" text NOT NULL,
	"subtotal_minor" bigint NOT NULL,
	"discount_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"total_minor" bigint NOT NULL,
	"refund_due_minor" bigint DEFAULT 0 NOT NULL,
	"contact" jsonb NOT NULL,
	"shipping_address" jsonb,
	"note" text,
	"price_quote_id" uuid,
	"quotation_id" uuid,
	"cart_id" uuid,
	"checkout_key" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp (3) with time zone,
	"confirmed_at" timestamp (3) with time zone,
	"cancelled_at" timestamp (3) with time zone,
	"cancel_reason" text,
	"expires_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "orders_status_ck" CHECK ("orders"."status" in ('awaiting_approval','pending_payment','confirmed','on_hold','cancelled')),
	CONSTRAINT "orders_payment_status_ck" CHECK ("orders"."payment_status" in ('unpaid','pending','paid','failed','refund_due')),
	CONSTRAINT "orders_total_ck" CHECK ("orders"."total_minor" = "orders"."subtotal_minor" - "orders"."discount_minor" + "orders"."tax_minor"),
	CONSTRAINT "orders_refund_ck" CHECK ("orders"."refund_due_minor" >= 0 and "orders"."refund_due_minor" <= "orders"."total_minor"),
	CONSTRAINT "orders_currency_ck" CHECK ("orders"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "orders_cancel_ck" CHECK (("orders"."status" = 'cancelled') = ("orders"."cancelled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"failure_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_status_ck" CHECK ("payments"."status" in ('pending','captured','failed')),
	CONSTRAINT "payments_amount_ck" CHECK ("payments"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"channel_id" uuid,
	"contact" jsonb NOT NULL,
	"notes" text,
	"lines" jsonb NOT NULL,
	"valid_until" timestamp (3) with time zone NOT NULL,
	"price_quote_id" uuid,
	"acceptance_note" text,
	"order_id" uuid,
	"cancel_reason" text,
	"created_by" uuid,
	"sent_at" timestamp (3) with time zone,
	"accepted_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "quotations_status_ck" CHECK ("quotations"."status" in ('draft','sent','accepted','converted','cancelled','expired')),
	CONSTRAINT "quotations_sent_ck" CHECK ("quotations"."status" in ('draft','cancelled') or "quotations"."price_quote_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_tenant_id_channel_id_channels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_tenant_id_order_id_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tenant_id_order_id_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_tenant_id_reservation_id_reservations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","reservation_id") REFERENCES "public"."reservations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_settings" ADD CONSTRAINT "order_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_channel_id_channels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_price_quote_id_price_quotes_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_quote_id") REFERENCES "public"."price_quotes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_order_id_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenant_id_channel_id_channels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenant_id_price_quote_id_price_quotes_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_quote_id") REFERENCES "public"."price_quotes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_order_line_uq" ON "order_lines" USING btree ("order_id","line_no");--> statement-breakpoint
CREATE INDEX "order_lines_reservation_idx" ON "order_lines" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_number_uq" ON "orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_key_uq" ON "orders" USING btree ("tenant_id","checkout_key") WHERE "orders"."checkout_key" is not null;--> statement-breakpoint
CREATE INDEX "orders_tenant_created_idx" ON "orders" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_due_idx" ON "orders" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_uq" ON "payment_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_pending_uq" ON "payments" USING btree ("order_id") WHERE "payments"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_tenant_number_uq" ON "quotations" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "quotations_due_idx" ON "quotations" USING btree ("status","valid_until");