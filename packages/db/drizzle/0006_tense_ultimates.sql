CREATE TABLE "sprint" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"board_id" text NOT NULL,
	"name" text NOT NULL,
	"goal" text,
	"state" text DEFAULT 'future' NOT NULL,
	"cycle" text DEFAULT '2w' NOT NULL,
	"start_at" timestamp,
	"end_at" timestamp,
	"capacity_points" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprint_issue" (
	"id" text PRIMARY KEY NOT NULL,
	"sprint_id" text NOT NULL,
	"issue_id" text NOT NULL,
	"planned_at_start" boolean DEFAULT false NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"removed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "sprint_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"sprint_id" text NOT NULL,
	"taken_at" timestamp DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"scope_issue_count" integer NOT NULL,
	"scope_points" integer NOT NULL,
	"completed_issue_count" integer NOT NULL,
	"completed_points" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sprint" ADD CONSTRAINT "sprint_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint" ADD CONSTRAINT "sprint_board_id_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_issue" ADD CONSTRAINT "sprint_issue_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_issue" ADD CONSTRAINT "sprint_issue_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_snapshot" ADD CONSTRAINT "sprint_snapshot_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sprint_board_idx" ON "sprint" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "sprint_org_idx" ON "sprint" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sprint_issue_sprint_idx" ON "sprint_issue" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "sprint_issue_issue_idx" ON "sprint_issue" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "sprint_snapshot_sprint_idx" ON "sprint_snapshot" USING btree ("sprint_id");--> statement-breakpoint
CREATE INDEX "issue_sprint_idx" ON "issue" USING btree ("sprint_id");