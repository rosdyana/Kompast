ALTER TABLE "project" ADD COLUMN "sprint_retro_template_page_id" text;--> statement-breakpoint
ALTER TABLE "sprint" ADD COLUMN "retro_page_id" text;--> statement-breakpoint
ALTER TABLE "sprint_issue" ADD COLUMN "rank" text;