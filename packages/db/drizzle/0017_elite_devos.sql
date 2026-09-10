DROP INDEX "project_org_key_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "project_team_key_uq" ON "project" USING btree ("organization_id","team_id","key");