ALTER TABLE "board" ALTER COLUMN "quick_filters" SET DATA TYPE jsonb USING "quick_filters"::jsonb;--> statement-breakpoint
ALTER TABLE "board" ALTER COLUMN "sprint_defaults" SET DATA TYPE jsonb USING "sprint_defaults"::jsonb;--> statement-breakpoint
ALTER TABLE "saved_view" ALTER COLUMN "config" SET DATA TYPE jsonb USING "config"::jsonb;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
