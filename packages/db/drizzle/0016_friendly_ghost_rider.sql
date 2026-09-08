ALTER TABLE "project" ADD COLUMN "sprint_minutes_template_page_id" text;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "sprint_id" text;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_sprint_id_sprint_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_sprint_idx" ON "page" USING btree ("sprint_id");