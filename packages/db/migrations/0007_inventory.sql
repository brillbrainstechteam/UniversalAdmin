CREATE TABLE "channel_stock_locations" (
	"tenant_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	CONSTRAINT "channel_stock_locations_channel_id_location_id_pk" PRIMARY KEY("channel_id","location_id")
);
--> statement-breakpoint
CREATE TABLE "reconciliation_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain" text DEFAULT 'inventory' NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"variant_id" uuid,
	"location_id" uuid,
	"details" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"dedupe_key" text NOT NULL,
	"resolved_by" uuid,
	"resolution_note" text,
	"resolved_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_issues_status_ck" CHECK ("reconciliation_issues"."status" in ('open','resolved'))
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"serial_item_id" uuid,
	"channel_id" uuid,
	"quantity" numeric(20, 6) NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"note" text,
	"created_by" uuid,
	"closed_reason" text,
	"closed_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "reservations_status_ck" CHECK ("reservations"."status" in ('held','committed','released','expired')),
	CONSTRAINT "reservations_qty_ck" CHECK ("reservations"."quantity" > 0),
	CONSTRAINT "reservations_hold_expiry_ck" CHECK ("reservations"."status" <> 'held' or "reservations"."expires_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"condition" text NOT NULL,
	"on_hand" numeric(20, 6) DEFAULT '0' NOT NULL,
	"reserved" numeric(20, 6) DEFAULT '0' NOT NULL,
	"committed" numeric(20, 6) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_condition_ck" CHECK ("stock_balances"."condition" in ('sellable','damaged','quarantine','in_transit')),
	CONSTRAINT "stock_balances_nonneg_ck" CHECK ("stock_balances"."on_hand" >= 0 and "stock_balances"."reserved" >= 0 and "stock_balances"."committed" >= 0),
	CONSTRAINT "stock_balances_cover_ck" CHECK ("stock_balances"."on_hand" >= "stock_balances"."reserved" + "stock_balances"."committed"),
	CONSTRAINT "stock_balances_holds_sellable_ck" CHECK ("stock_balances"."condition" = 'sellable' or ("stock_balances"."reserved" = 0 and "stock_balances"."committed" = 0))
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"counted" numeric(20, 6) NOT NULL,
	"expected" numeric(20, 6) NOT NULL,
	"variance" numeric(20, 6) NOT NULL,
	CONSTRAINT "stock_count_lines_counted_ck" CHECK ("stock_count_lines"."counted" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"source" text DEFAULT 'stocktake' NOT NULL,
	"source_version" text,
	"as_of" timestamp (3) with time zone NOT NULL,
	"status" text NOT NULL,
	"reference" text,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_counts_status_ck" CHECK ("stock_counts"."status" in ('applied','rejected_stale'))
);
--> statement-breakpoint
CREATE TABLE "stock_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"reference" text,
	"actor_user_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_documents_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"condition" text NOT NULL,
	"serial_item_id" uuid,
	"type" text NOT NULL,
	"on_hand_delta" numeric(20, 6) DEFAULT '0' NOT NULL,
	"reserved_delta" numeric(20, 6) DEFAULT '0' NOT NULL,
	"committed_delta" numeric(20, 6) DEFAULT '0' NOT NULL,
	"reason_code" text,
	"note" text,
	"reference" text,
	"operation_id" uuid NOT NULL,
	"reservation_id" uuid,
	"actor_user_id" uuid,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_type_ck" CHECK ("stock_movements"."type" in ('receipt','adjustment','condition_change','transfer_dispatch','transfer_receive','transfer_cancel','stocktake','reservation_hold','reservation_release','reservation_expire','reservation_commit','commitment_release','write_off')),
	CONSTRAINT "stock_movements_nonzero_ck" CHECK ("stock_movements"."on_hand_delta" <> 0 or "stock_movements"."reserved_delta" <> 0 or "stock_movements"."committed_delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "stock_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"default_buffer" numeric(20, 6) DEFAULT '0' NOT NULL,
	"reservation_ttl_minutes" integer DEFAULT 15 NOT NULL,
	"low_stock_threshold" numeric(20, 6) DEFAULT '1' NOT NULL,
	"backorder_policy" text DEFAULT 'disabled' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_settings_buffer_ck" CHECK ("stock_settings"."default_buffer" >= 0),
	CONSTRAINT "stock_settings_ttl_ck" CHECK ("stock_settings"."reservation_ttl_minutes" between 1 and 10080)
);
--> statement-breakpoint
CREATE TABLE "transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"serial_item_id" uuid,
	"quantity" numeric(20, 6) NOT NULL,
	CONSTRAINT "transfer_lines_qty_ck" CHECK ("transfer_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"status" text DEFAULT 'in_transit' NOT NULL,
	"note" text,
	"created_by" uuid,
	"received_by" uuid,
	"received_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "transfers_distinct_ck" CHECK ("transfers"."from_location_id" <> "transfers"."to_location_id"),
	CONSTRAINT "transfers_status_ck" CHECK ("transfers"."status" in ('in_transit','received','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "variant_stock_settings" (
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"tracking" text DEFAULT 'quantity' NOT NULL,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"buffer" numeric(20, 6),
	"low_stock_threshold" numeric(20, 6),
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_stock_settings_tenant_id_variant_id_pk" PRIMARY KEY("tenant_id","variant_id"),
	CONSTRAINT "variant_stock_settings_buffer_ck" CHECK ("variant_stock_settings"."buffer" is null or "variant_stock_settings"."buffer" >= 0),
	CONSTRAINT "variant_stock_settings_serial_pcs_ck" CHECK ("variant_stock_settings"."tracking" <> 'serial' or "variant_stock_settings"."unit" = 'pcs')
);
--> statement-breakpoint
ALTER TABLE "serial_items" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "serial_items" ADD COLUMN "stock_state" text DEFAULT 'not_received' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_stock_locations" ADD CONSTRAINT "channel_stock_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_stock_locations" ADD CONSTRAINT "channel_stock_locations_tenant_id_channel_id_channels_tenant_id_id_fk" FOREIGN KEY ("tenant_id","channel_id") REFERENCES "public"."channels"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_stock_locations" ADD CONSTRAINT "channel_stock_locations_tenant_id_location_id_locations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_location_id_locations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_serial_item_id_serial_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","serial_item_id") REFERENCES "public"."serial_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_location_id_locations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_count_id_stock_counts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","count_id") REFERENCES "public"."stock_counts"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tenant_id_location_id_locations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_location_id_locations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_serial_item_id_serial_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","serial_item_id") REFERENCES "public"."serial_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_settings" ADD CONSTRAINT "stock_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_tenant_id_transfer_id_transfers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","transfer_id") REFERENCES "public"."transfers"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_tenant_id_serial_item_id_serial_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","serial_item_id") REFERENCES "public"."serial_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_tenant_id_from_location_id_locations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","from_location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_tenant_id_to_location_id_locations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","to_location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_stock_settings" ADD CONSTRAINT "variant_stock_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_stock_settings" ADD CONSTRAINT "variant_stock_settings_tenant_id_variant_id_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."variants"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_issues_open_uq" ON "reconciliation_issues" USING btree ("tenant_id","dedupe_key") WHERE "reconciliation_issues"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reconciliation_issues_status_idx" ON "reconciliation_issues" USING btree ("tenant_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_idempotency_uq" ON "reservations" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "reservations_due_idx" ON "reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "reservations_variant_idx" ON "reservations" USING btree ("tenant_id","variant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_serial_active_uq" ON "reservations" USING btree ("tenant_id","serial_item_id") WHERE "reservations"."serial_item_id" is not null and "reservations"."status" in ('held','committed');--> statement-breakpoint
CREATE UNIQUE INDEX "stock_balances_key_uq" ON "stock_balances" USING btree ("tenant_id","variant_id","location_id","condition");--> statement-breakpoint
CREATE INDEX "stock_balances_location_idx" ON "stock_balances" USING btree ("tenant_id","location_id");--> statement-breakpoint
CREATE INDEX "stock_counts_location_idx" ON "stock_counts" USING btree ("tenant_id","location_id","source","as_of" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "stock_documents_reference_uq" ON "stock_documents" USING btree ("tenant_id","type","reference") WHERE "stock_documents"."reference" is not null;--> statement-breakpoint
CREATE INDEX "stock_movements_variant_idx" ON "stock_movements" USING btree ("tenant_id","variant_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_movements_operation_idx" ON "stock_movements" USING btree ("tenant_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_number_uq" ON "transfers" USING btree ("tenant_id","number");--> statement-breakpoint
ALTER TABLE "serial_items" ADD CONSTRAINT "serial_items_tenant_id_location_id_locations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_items" ADD CONSTRAINT "serial_items_stock_state_ck" CHECK ("serial_items"."stock_state" in ('not_received','in_stock','reserved','committed','in_transit','written_off'));--> statement-breakpoint
ALTER TABLE "serial_items" ADD CONSTRAINT "serial_items_located_ck" CHECK ("serial_items"."stock_state" in ('not_received','written_off') or "serial_items"."location_id" is not null);