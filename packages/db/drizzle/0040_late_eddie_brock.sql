ALTER TABLE "issue_attachment" ALTER COLUMN "storage_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_attachment" ADD COLUMN "status" text DEFAULT 'stored' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_attachment" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "issue_attachment" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "issue_attachment" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;