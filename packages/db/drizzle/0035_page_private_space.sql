ALTER TABLE "page" DROP CONSTRAINT "page_single_space_ck";--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "private_owner_id" text;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_private_owner_id_user_id_fk" FOREIGN KEY ("private_owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_private_owner_idx" ON "page" USING btree ("private_owner_id");--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_single_space_ck" CHECK (num_nonnulls("page"."team_id", "page"."project_id", "page"."private_owner_id") <= 1);