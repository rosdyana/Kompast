ALTER TABLE "invitation" ADD COLUMN "team_role" text;--> statement-breakpoint
ALTER TABLE "page" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_member_user_idx" ON "team_member" USING btree ("user_id","team_id");--> statement-breakpoint
CREATE INDEX "page_team_idx" ON "page" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_single_space_ck" CHECK (not ("page"."team_id" is not null and "page"."project_id" is not null));