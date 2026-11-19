ALTER TABLE "board_column" ADD COLUMN "stuck_after_days" integer;--> statement-breakpoint
ALTER TABLE "ai_message" ADD COLUMN "proposals" jsonb;