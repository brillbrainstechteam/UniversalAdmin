CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"credential_ref" text,
	"settings" jsonb NOT NULL,
	"ownership" jsonb NOT NULL,
	"adapter_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_mapping_version" integer,
	"last_sync_at" timestamp (3) with time zone,
	"last_success_at" timestamp (3) with time zone,
	"created_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "connections_status_ck" CHECK ("connections"."status" in ('active','paused','disconnected')),
	CONSTRAINT "connections_credential_ref_ck" CHECK ("connections"."credential_ref" is null or "connections"."credential_ref" ~ '^(vault|env|secretsmanager):')
);
--> statement-breakpoint
CREATE TABLE "connector_discovery" (
	"tenant_id" uuid NOT NULL,
	"connector_key" text NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"answers" jsonb NOT NULL,
	"notes" text,
	"updated_by" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_discovery_tenant_id_connector_key_pk" PRIMARY KEY("tenant_id","connector_key")
);
--> statement-breakpoint
CREATE TABLE "external_records" (
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"external_id" text NOT NULL,
	"internal_type" text NOT NULL,
	"internal_id" uuid NOT NULL,
	"external_version" text,
	"source_timestamp" timestamp (3) with time zone,
	"checksum" text NOT NULL,
	"last_job_id" uuid,
	"last_stock" jsonb,
	"deleted_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_records_connection_id_record_type_external_id_pk" PRIMARY KEY("connection_id","record_type","external_id")
);
--> statement-breakpoint
CREATE TABLE "field_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rules" jsonb NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reference" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone,
	"last_error" text,
	"external_ref" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp (3) with time zone,
	CONSTRAINT "outbound_commands_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "outbound_commands_status_ck" CHECK ("outbound_commands"."status" in ('pending','acknowledged','failed'))
);
--> statement-breakpoint
CREATE TABLE "sync_checkpoints" (
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"cursor" text NOT NULL,
	"source_timestamp" timestamp (3) with time zone,
	"job_id" uuid,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_checkpoints_connection_id_stream_pk" PRIMARY KEY("connection_id","stream")
);
--> statement-breakpoint
CREATE TABLE "sync_job_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"row_no" integer NOT NULL,
	"external_id" text,
	"action" text NOT NULL,
	"applied" text DEFAULT 'no' NOT NULL,
	"errors" jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"record" jsonb,
	"checksum" text
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"mapping_version" integer NOT NULL,
	"file_name" text,
	"file_sha256" text,
	"cursor_from" text,
	"cursor_to" text,
	"snapshot_as_of" timestamp (3) with time zone NOT NULL,
	"counts" jsonb NOT NULL,
	"stock_result" jsonb,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp (3) with time zone,
	CONSTRAINT "sync_jobs_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "sync_jobs_status_ck" CHECK ("sync_jobs"."status" in ('previewed','committed','partially_committed','discarded','failed'))
);
--> statement-breakpoint
ALTER TABLE "stock_counts" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_discovery" ADD CONSTRAINT "connector_discovery_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_discovery" ADD CONSTRAINT "connector_discovery_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_tenant_id_connection_id_connections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_mappings" ADD CONSTRAINT "field_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_mappings" ADD CONSTRAINT "field_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_mappings" ADD CONSTRAINT "field_mappings_tenant_id_connection_id_connections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_commands" ADD CONSTRAINT "outbound_commands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_commands" ADD CONSTRAINT "outbound_commands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_commands" ADD CONSTRAINT "outbound_commands_tenant_id_connection_id_connections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_checkpoints" ADD CONSTRAINT "sync_checkpoints_tenant_id_connection_id_connections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_job_rows" ADD CONSTRAINT "sync_job_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_job_rows" ADD CONSTRAINT "sync_job_rows_tenant_id_job_id_sync_jobs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."sync_jobs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_tenant_id_connection_id_connections_tenant_id_id_fk" FOREIGN KEY ("tenant_id","connection_id") REFERENCES "public"."connections"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_tenant_name_uq" ON "connections" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "external_records_internal_uq" ON "external_records" USING btree ("connection_id","internal_type","internal_id");--> statement-breakpoint
CREATE INDEX "external_records_internal_idx" ON "external_records" USING btree ("tenant_id","internal_type","internal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "field_mappings_version_uq" ON "field_mappings" USING btree ("connection_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_commands_reference_uq" ON "outbound_commands" USING btree ("connection_id","reference");--> statement-breakpoint
CREATE INDEX "outbound_commands_due_idx" ON "outbound_commands" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_job_rows_row_uq" ON "sync_job_rows" USING btree ("job_id","row_no");--> statement-breakpoint
CREATE INDEX "sync_job_rows_action_idx" ON "sync_job_rows" USING btree ("job_id","action");--> statement-breakpoint
CREATE INDEX "sync_jobs_connection_idx" ON "sync_jobs" USING btree ("tenant_id","connection_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_counts_connection_idx" ON "stock_counts" USING btree ("tenant_id","connection_id","location_id","as_of" DESC NULLS LAST);