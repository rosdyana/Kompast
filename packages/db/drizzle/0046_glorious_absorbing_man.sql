CREATE TABLE "issue_comment_reaction" (
	"id" text PRIMARY KEY NOT NULL,
	"comment_id" text NOT NULL,
	"user_id" text NOT NULL,
	"emoji" text NOT NULL,
	"origin" text DEFAULT 'user' NOT NULL,
	"origin_client" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_comment_reaction" ADD CONSTRAINT "issue_comment_reaction_comment_id_issue_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."issue_comment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_reaction" ADD CONSTRAINT "issue_comment_reaction_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_comment_reaction_uq" ON "issue_comment_reaction" USING btree ("comment_id","user_id","emoji");--> statement-breakpoint
CREATE INDEX "issue_comment_reaction_comment_idx" ON "issue_comment_reaction" USING btree ("comment_id");