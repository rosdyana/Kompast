CREATE TABLE "external_ref" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"source_url" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"import_run_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"config" jsonb NOT NULL,
	"counts" jsonb,
	"errors" jsonb,
	"created_by" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_ref" ADD CONSTRAINT "external_ref_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ref" ADD CONSTRAINT "external_ref_import_run_id_import_run_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."import_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_ref_source_uq" ON "external_ref" USING btree ("organization_id","source","source_id");--> statement-breakpoint
CREATE INDEX "external_ref_entity_idx" ON "external_ref" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "import_run_project_idx" ON "import_run" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "import_run_status_idx" ON "import_run" USING btree ("status");