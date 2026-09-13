CREATE TABLE "automation_edge" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"from_node_id" text NOT NULL,
	"from_handle" text,
	"to_node_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_node" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" jsonb DEFAULT '{"x":0,"y":0}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_workflow" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_workflow_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"event_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"caused_by_workflow_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_workflow_run" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"context" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_workflow_run_step" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"output" jsonb,
	"error" text,
	"resume_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_edge" ADD CONSTRAINT "automation_edge_workflow_id_automation_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."automation_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_edge" ADD CONSTRAINT "automation_edge_from_node_id_automation_node_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."automation_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_edge" ADD CONSTRAINT "automation_edge_to_node_id_automation_node_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."automation_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_node" ADD CONSTRAINT "automation_node_workflow_id_automation_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."automation_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow" ADD CONSTRAINT "automation_workflow_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow" ADD CONSTRAINT "automation_workflow_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow" ADD CONSTRAINT "automation_workflow_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow_event" ADD CONSTRAINT "automation_workflow_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow_event" ADD CONSTRAINT "automation_workflow_event_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow_event" ADD CONSTRAINT "automation_workflow_event_caused_by_workflow_id_automation_workflow_id_fk" FOREIGN KEY ("caused_by_workflow_id") REFERENCES "public"."automation_workflow"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow_run" ADD CONSTRAINT "automation_workflow_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow_run" ADD CONSTRAINT "automation_workflow_run_workflow_id_automation_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."automation_workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow_run_step" ADD CONSTRAINT "automation_workflow_run_step_run_id_automation_workflow_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_workflow_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_workflow_run_step" ADD CONSTRAINT "automation_workflow_run_step_node_id_automation_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."automation_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_edge_workflow_idx" ON "automation_edge" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "automation_edge_from_idx" ON "automation_edge" USING btree ("from_node_id");--> statement-breakpoint
CREATE INDEX "automation_node_workflow_idx" ON "automation_node" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "automation_workflow_project_idx" ON "automation_workflow" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "automation_workflow_org_idx" ON "automation_workflow" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "automation_workflow_event_status_idx" ON "automation_workflow_event" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_workflow_event_project_idx" ON "automation_workflow_event" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "automation_workflow_run_workflow_idx" ON "automation_workflow_run" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "automation_workflow_run_step_run_idx" ON "automation_workflow_run_step" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "automation_workflow_run_step_status_idx" ON "automation_workflow_run_step" USING btree ("status");