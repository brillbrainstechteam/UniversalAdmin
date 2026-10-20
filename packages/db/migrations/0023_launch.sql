CREATE TABLE "plans" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"limits" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_key_ck" CHECK ("plans"."key" ~ '^[a-z][a-z0-9_]{1,39}$'),
	CONSTRAINT "plans_status_ck" CHECK ("plans"."status" in ('active','retired'))
);
--> statement-breakpoint
CREATE TABLE "support_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"ticket_ref" text,
	"duration_minutes" integer NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp (3) with time zone,
	"decision_note" text,
	"expires_at" timestamp (3) with time zone,
	"started_at" timestamp (3) with time zone,
	"revoked_by" uuid,
	"revoked_at" timestamp (3) with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_grants_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_grants_status_ck" CHECK ("support_grants"."status" in ('requested','approved','denied','revoked')),
	CONSTRAINT "support_grants_duration_ck" CHECK ("support_grants"."duration_minutes" between 15 and 120),
	CONSTRAINT "support_grants_approved_ck" CHECK ("support_grants"."status" <> 'approved' or "support_grants"."expires_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "support_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "plan_key" text DEFAULT 'pilot' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_grants_tenant_idx" ON "support_grants" USING btree ("tenant_id","created_at" DESC NULLS LAST);