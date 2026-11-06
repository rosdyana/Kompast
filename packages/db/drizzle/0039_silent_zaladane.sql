ALTER TABLE "issue" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "import_run" ADD COLUMN "notes" jsonb;