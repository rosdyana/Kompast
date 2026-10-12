ALTER TABLE "page" ADD COLUMN "shared_with" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "page_shared_with_idx" ON "page" USING gin ("shared_with");--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_shared_needs_owner_ck" CHECK (cardinality("page"."shared_with") = 0 or "page"."private_owner_id" is not null);