import { and, eq, schema, SYSTEM_SETTINGS_ID } from "@kompast/db";
import type { AnyDb } from "./types";
import { encryptSecret, decryptSecret } from "./crypto";
import { ForbiddenError } from "./permissions";

const MICROSOFT_TENANT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getRow(db: AnyDb) {
  const [row] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.id, SYSTEM_SETTINGS_ID));
  return row ?? null;
}

export async function getSetupStatus(db: AnyDb) {
  const row = await getRow(db);
  return {
    isConfigured: Boolean(row?.microsoftTenantId && row.microsoftClientId && row.microsoftClientSecretEncrypted),
  };
}

/**
 * Returns decrypted Entra ID credentials for building the auth instance
 * (apps/web/src/lib/auth.ts `getAuth()`), or null if setup hasn't run yet
 * — the caller is expected to omit the genericOAuth plugin entirely in
 * that case, not pass empty strings into it (microsoftEntraId() throws on
 * a non-GUID tenant regardless).
 */
export async function getMicrosoftAuthConfig(db: AnyDb) {
  const row = await getRow(db);
  if (!row?.microsoftTenantId || !row.microsoftClientId || !row.microsoftClientSecretEncrypted) return null;
  return {
    tenantId: row.microsoftTenantId,
    clientId: row.microsoftClientId,
    clientSecret: decryptSecret(row.microsoftClientSecretEncrypted),
  };
}

export interface CompleteSetupInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Optional because the very first call happens before any user exists — nobody to attribute it to yet. */
  updatedBy?: string;
}

/**
 * One-time bootstrap write. Callers (the /setup server function) must
 * check getSetupStatus() first and refuse to run this if already
 * configured — this function itself doesn't re-check, so it stays a plain
 * upsert usable for later re-editing by a real admin too (see
 * updateMicrosoftAuthConfig below, which is the same operation post-setup).
 */
export async function completeSetup(db: AnyDb, input: CompleteSetupInput) {
  if (!MICROSOFT_TENANT_GUID_RE.test(input.tenantId)) {
    throw new Error(
      "Microsoft Tenant ID must be a concrete tenant GUID (not \"common\"/\"organizations\"/\"consumers\").",
    );
  }
  await db
    .insert(schema.systemSettings)
    .values({
      id: SYSTEM_SETTINGS_ID,
      microsoftTenantId: input.tenantId,
      microsoftClientId: input.clientId,
      microsoftClientSecretEncrypted: encryptSecret(input.clientSecret),
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.systemSettings.id,
      set: {
        microsoftTenantId: input.tenantId,
        microsoftClientId: input.clientId,
        microsoftClientSecretEncrypted: encryptSecret(input.clientSecret),
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    });
}

/** Whether ctx.userId is an owner/admin of ctx.organizationId — the gate for /settings. */
export async function requireSystemAdmin(db: AnyDb, ctx: { userId: string; organizationId: string }) {
  const [row] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId)));
  if (!row || (row.role !== "owner" && row.role !== "admin")) {
    throw new ForbiddenError(`User ${ctx.userId} is not an owner/admin of organization ${ctx.organizationId}`);
  }
}

export interface AiSettingsView {
  provider: "anthropic" | "azure-openai" | "openai-compatible" | null;
  hasApiKey: boolean;
  azureEndpoint: string | null;
  azureDeployment: string | null;
  openAiCompatibleBaseUrl: string | null;
  featuresEnabled: boolean;
}

export async function getAiSettings(db: AnyDb): Promise<AiSettingsView> {
  const row = await getRow(db);
  return {
    provider: (row?.aiProvider as AiSettingsView["provider"]) ?? null,
    hasApiKey: Boolean(row?.aiApiKeyEncrypted),
    azureEndpoint: row?.aiAzureEndpoint ?? null,
    azureDeployment: row?.aiAzureDeployment ?? null,
    openAiCompatibleBaseUrl: row?.aiOpenAiCompatibleBaseUrl ?? null,
    featuresEnabled: row?.aiFeaturesEnabled ?? false,
  };
}

export interface UpdateAiSettingsInput {
  provider: "anthropic" | "azure-openai" | "openai-compatible";
  /** Omit to keep the existing stored key (e.g. editing other fields without re-entering a secret). */
  apiKey?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  openAiCompatibleBaseUrl?: string;
  featuresEnabled: boolean;
  updatedBy: string;
}

export async function updateAiSettings(db: AnyDb, input: UpdateAiSettingsInput) {
  await db
    .insert(schema.systemSettings)
    .values({
      id: SYSTEM_SETTINGS_ID,
      aiProvider: input.provider,
      aiApiKeyEncrypted: input.apiKey ? encryptSecret(input.apiKey) : null,
      aiAzureEndpoint: input.azureEndpoint,
      aiAzureDeployment: input.azureDeployment,
      aiOpenAiCompatibleBaseUrl: input.openAiCompatibleBaseUrl,
      aiFeaturesEnabled: input.featuresEnabled,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.systemSettings.id,
      set: {
        aiProvider: input.provider,
        ...(input.apiKey ? { aiApiKeyEncrypted: encryptSecret(input.apiKey) } : {}),
        aiAzureEndpoint: input.azureEndpoint,
        aiAzureDeployment: input.azureDeployment,
        aiOpenAiCompatibleBaseUrl: input.openAiCompatibleBaseUrl,
        aiFeaturesEnabled: input.featuresEnabled,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    });
}

export interface MailSettingsView {
  driver: "brevo" | "resend" | "smtp" | null;
  from: string | null;
  hasApiKey: boolean;
  hasSmtpUrl: boolean;
}

export async function getMailSettings(db: AnyDb): Promise<MailSettingsView> {
  const row = await getRow(db);
  return {
    driver: (row?.mailDriver as MailSettingsView["driver"]) ?? null,
    from: row?.mailFrom ?? null,
    hasApiKey: Boolean(row?.mailApiKeyEncrypted),
    hasSmtpUrl: Boolean(row?.mailSmtpUrlEncrypted),
  };
}

export interface UpdateMailSettingsInput {
  driver: "brevo" | "resend" | "smtp";
  from: string;
  apiKey?: string;
  smtpUrl?: string;
  updatedBy: string;
}

export async function updateMailSettings(db: AnyDb, input: UpdateMailSettingsInput) {
  await db
    .insert(schema.systemSettings)
    .values({
      id: SYSTEM_SETTINGS_ID,
      mailDriver: input.driver,
      mailFrom: input.from,
      mailApiKeyEncrypted: input.apiKey ? encryptSecret(input.apiKey) : null,
      mailSmtpUrlEncrypted: input.smtpUrl ? encryptSecret(input.smtpUrl) : null,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.systemSettings.id,
      set: {
        mailDriver: input.driver,
        mailFrom: input.from,
        ...(input.apiKey ? { mailApiKeyEncrypted: encryptSecret(input.apiKey) } : {}),
        ...(input.smtpUrl ? { mailSmtpUrlEncrypted: encryptSecret(input.smtpUrl) } : {}),
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    });
}
