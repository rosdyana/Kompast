CREATE TABLE "system_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"microsoft_tenant_id" text,
	"microsoft_client_id" text,
	"microsoft_client_secret_encrypted" text,
	"ai_provider" text,
	"ai_api_key_encrypted" text,
	"ai_azure_endpoint" text,
	"ai_azure_deployment" text,
	"ai_openai_compatible_base_url" text,
	"ai_features_enabled" boolean DEFAULT false NOT NULL,
	"mail_driver" text,
	"mail_from" text,
	"mail_api_key_encrypted" text,
	"mail_smtp_url_encrypted" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;