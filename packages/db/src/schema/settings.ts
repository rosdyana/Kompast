import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * Singleton (id is always the literal "singleton") deployment-wide config:
 * Microsoft Entra ID connection, AI provider, and mail vendor. Deliberately
 * NOT organization-scoped — one Entra tenant, one LLM contract, one email
 * sending domain per deployment, configured once via /setup (Microsoft
 * auth, gating first login) and /settings (AI + mail, admin-only,
 * post-login). Secrets are stored via packages/core's encryptSecret(),
 * never in plaintext — see crypto.ts.
 *
 * No RLS here: there is no "current workspace" before the first
 * organization exists, and after that this table still isn't
 * organization-scoped. Access is gated at the service layer instead
 * (requireSystemAdmin in packages/core), not by a workspace GUC.
 */
export const systemSettings = pgTable("system_settings", {
  id: text("id").primaryKey(),

  microsoftTenantId: text("microsoft_tenant_id"),
  microsoftClientId: text("microsoft_client_id"),
  microsoftClientSecretEncrypted: text("microsoft_client_secret_encrypted"),

  aiProvider: text("ai_provider", { enum: ["anthropic", "azure-openai", "openai-compatible"] }),
  aiApiKeyEncrypted: text("ai_api_key_encrypted"),
  /** Ignored for azure-openai (aiAzureDeployment selects the model). Optional for anthropic (a default is used if unset). Required at call time for openai-compatible — arbitrary endpoints have no safe default model name. */
  aiModel: text("ai_model"),
  aiAzureEndpoint: text("ai_azure_endpoint"),
  aiAzureDeployment: text("ai_azure_deployment"),
  aiOpenAiCompatibleBaseUrl: text("ai_openai_compatible_base_url"),
  aiFeaturesEnabled: boolean("ai_features_enabled").notNull().default(false),

  mailDriver: text("mail_driver", { enum: ["brevo", "resend", "smtp"] }),
  mailFrom: text("mail_from"),
  mailApiKeyEncrypted: text("mail_api_key_encrypted"),
  mailSmtpUrlEncrypted: text("mail_smtp_url_encrypted"),

  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").references(() => user.id),
});

export const SYSTEM_SETTINGS_ID = "singleton";
