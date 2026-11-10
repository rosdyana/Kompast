ALTER TABLE "email_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_workflow_event" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_workflow_run_step" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "embedding_index_queue" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "embedding_index_queue" ADD COLUMN "claimed_at" timestamp;