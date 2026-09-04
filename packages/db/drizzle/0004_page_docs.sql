CREATE TABLE "link" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"from_type" text NOT NULL,
	"from_id" text NOT NULL,
	"to_type" text NOT NULL,
	"to_id" text NOT NULL,
	"kind" text DEFAULT 'reference' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"parent_page_id" text,
	"title" text DEFAULT '' NOT NULL,
	"icon" text,
	"cover" text,
	"type" text DEFAULT 'doc' NOT NULL,
	"rank" text NOT NULL,
	"archived_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"block_id" text NOT NULL,
	"author_id" text NOT NULL,
	"body_json" jsonb NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_favorite" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_permission" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"role" text DEFAULT 'view' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_version" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"snapshot" "bytea" NOT NULL,
	"author_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_link" (
	"id" text PRIMARY KEY NOT NULL,
	"page_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"scope" text DEFAULT 'view' NOT NULL,
	"password_hash" text,
	"include_embeds" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "share_link_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "ydoc_state" (
	"page_id" text PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comment" ADD CONSTRAINT "page_comment_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_favorite" ADD CONSTRAINT "page_favorite_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_favorite" ADD CONSTRAINT "page_favorite_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_permission" ADD CONSTRAINT "page_permission_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_version" ADD CONSTRAINT "page_version_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_version" ADD CONSTRAINT "page_version_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ydoc_state" ADD CONSTRAINT "ydoc_state_page_id_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."page"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "link_uq" ON "link" USING btree ("from_type","from_id","to_type","to_id","kind");--> statement-breakpoint
CREATE INDEX "link_to_idx" ON "link" USING btree ("to_type","to_id");--> statement-breakpoint
CREATE INDEX "page_parent_idx" ON "page" USING btree ("parent_page_id");--> statement-breakpoint
CREATE INDEX "page_project_idx" ON "page" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_comment_page_idx" ON "page_comment" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_favorite_uq" ON "page_favorite" USING btree ("page_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_permission_uq" ON "page_permission" USING btree ("page_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "page_version_page_idx" ON "page_version" USING btree ("page_id");