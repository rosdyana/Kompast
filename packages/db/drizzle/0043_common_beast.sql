CREATE TABLE "notion_migration" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text NOT NULL,
	"workspace_name" text DEFAULT '' NOT NULL,
	"token_encrypted" text,
	"token_cleared_at" timestamp,
	"state" text DEFAULT 'draft' NOT NULL,
	"discovery" jsonb,
	"selection" jsonb,
	"progress" jsonb,
	"cursor" jsonb,
	"import_run_id" text,
	"lease_expires_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notion_migration" ADD CONSTRAINT "notion_migration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notion_migration" ADD CONSTRAINT "notion_migration_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notion_migration_org_idx" ON "notion_migration" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notion_migration_state_idx" ON "notion_migration" USING btree ("state");