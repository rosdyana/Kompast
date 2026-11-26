-- Links created before this column were made under "anyone with the link,
-- no sign-in" copy, so they keep working as public links: the column is added
-- with DEFAULT 'public' (fills existing rows without an UPDATE, which FORCE RLS
-- on share_link could turn into a silent no-op), then new links default to
-- signed_in. The Share popover badges the old ones Public so owners can revoke them.
ALTER TABLE "share_link" ADD COLUMN "access" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "share_link" ALTER COLUMN "access" SET DEFAULT 'signed_in';
