ALTER TABLE "user" ADD COLUMN "last_seen_at" timestamp;--> statement-breakpoint
-- Backfill: best available signal is the later of the last sign-in and the
-- last time a still-existing session was refreshed.
UPDATE "user" u SET "last_seen_at" = GREATEST(u."last_login_at", (SELECT max(s."updated_at") FROM "session" s WHERE s."user_id" = u."id"));
