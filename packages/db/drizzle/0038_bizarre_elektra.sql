CREATE TABLE "jira_migration" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"board_id" text NOT NULL,
	"created_by" text NOT NULL,
	"site_url" text NOT NULL,
	"email" text NOT NULL,
	"api_token_encrypted" text,
	"token_cleared_at" timestamp,
	"jira_project_key" text NOT NULL,
	"jira_board_id" integer,
	"state" text DEFAULT 'draft' NOT NULL,
	"discovery" jsonb,
	"mapping" jsonb,
	"progress" jsonb,
	"cursor" jsonb,
	"last_synced_at" timestamp,
	"lease_expires_at" timestamp,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_run" ADD COLUMN "migration_id" text;--> statement-breakpoint
ALTER TABLE "jira_migration" ADD CONSTRAINT "jira_migration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_migration" ADD CONSTRAINT "jira_migration_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jira_migration" ADD CONSTRAINT "jira_migration_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jira_migration_project_uq" ON "jira_migration" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "jira_migration_project_idx" ON "jira_migration" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "jira_migration_state_idx" ON "jira_migration" USING btree ("state");--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_migration_id_jira_migration_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."jira_migration"("id") ON DELETE set null ON UPDATE no action;