ALTER TABLE "member" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_member" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_super_admin_uq" ON "member" USING btree ("organization_id") WHERE "member"."is_super_admin" = true;--> statement-breakpoint
-- Hand-written backfill (drizzle-kit only generates schema, not data
-- migrations): give every existing workspace exactly one super admin
-- immediately, rather than leaving it unset until someone manually assigns
-- one. Picks the current "owner" member row per organization. Guarded by
-- NOT EXISTS so this is safe to run even if a workspace already has one
-- (e.g. a partial re-run), and so multiple "owner" rows in one org (should
-- never happen, but nothing enforces it) don't violate the new unique index.
UPDATE "member" m SET "is_super_admin" = true
WHERE m.role = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM "member" m2
    WHERE m2.organization_id = m.organization_id AND m2.is_super_admin = true
  );