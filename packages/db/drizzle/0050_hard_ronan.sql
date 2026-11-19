ALTER TABLE "system_settings" ADD COLUMN "sso_recovery_code_hash" text;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "sso_recovery_expires_at" timestamp with time zone;