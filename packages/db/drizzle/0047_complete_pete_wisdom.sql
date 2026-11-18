ALTER TABLE "user" ADD COLUMN "last_login_at" timestamp;--> statement-breakpoint
-- Backfill from the sessions that still exist (sign-out/expiry delete theirs, so this is a lower bound).
UPDATE "user" u SET "last_login_at" = s.latest FROM (SELECT "user_id", max("created_at") AS latest FROM "session" GROUP BY "user_id") s WHERE s."user_id" = u."id";
