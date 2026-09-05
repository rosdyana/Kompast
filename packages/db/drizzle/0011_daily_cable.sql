CREATE TABLE "ai_message" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"vector" vector(1536) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embedding_index_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "embedding_provider" text;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "embedding_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "embedding_model" text;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "embedding_azure_endpoint" text;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "embedding_azure_deployment" text;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "embedding_openai_compatible_base_url" text;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "embedding_features_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_thread_id_ai_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."ai_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_thread" ADD CONSTRAINT "ai_thread_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_thread" ADD CONSTRAINT "ai_thread_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding" ADD CONSTRAINT "embedding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_index_queue" ADD CONSTRAINT "embedding_index_queue_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_message_thread_idx" ON "ai_message" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "ai_thread_org_user_idx" ON "ai_thread" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_entity_chunk_uq" ON "embedding" USING btree ("entity_type","entity_id","chunk_index");--> statement-breakpoint
CREATE INDEX "embedding_org_idx" ON "embedding" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "embedding_vector_hnsw_idx" ON "embedding" USING hnsw ("vector" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "embedding_index_queue_status_idx" ON "embedding_index_queue" USING btree ("status");