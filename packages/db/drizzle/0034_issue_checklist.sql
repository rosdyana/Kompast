CREATE TABLE "issue_checklist_item" (
	"id" text PRIMARY KEY NOT NULL,
	"issue_id" text NOT NULL,
	"text" text NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"rank" text COLLATE "C" NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_checklist_item" ADD CONSTRAINT "issue_checklist_item_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_checklist_item" ADD CONSTRAINT "issue_checklist_item_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_checklist_item_issue_idx" ON "issue_checklist_item" USING btree ("issue_id");