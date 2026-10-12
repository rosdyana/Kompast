ALTER TABLE "page" DROP CONSTRAINT "page_team_id_team_id_fk";
--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE no action ON UPDATE no action;