import { and, asc, eq, schema, SYSTEM_SETTINGS_ID } from "@kompast/db";
import type { AnyDb } from "./types";
import { encryptSecret, decryptSecret } from "./crypto";
import { ForbiddenError } from "./permissions";
import { InvalidInputError } from "./errors";

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

export interface MicrosoftAuthSettingsView {
  tenantId: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
}

/** Masked view for the admin-gated re-edit form (see /settings) — never echoes the decrypted client secret back, same treatment as getAiSettings/getMailSettings. */
export async function getMicrosoftAuthSettingsView(db: AnyDb): Promise<MicrosoftAuthSettingsView> {
  const row = await getRow(db);
  return {
    tenantId: row?.microsoftTenantId ?? null,
    clientId: row?.microsoftClientId ?? null,
    hasClientSecret: Boolean(row?.microsoftClientSecretEncrypted),
  };
}

export interface CompleteSetupInput {
  tenantId: string;
  clientId: string;
  /** Omit on a re-edit to keep the existing stored secret — same "blank means unchanged" convention as updateAiSettings/updateMailSettings. Required on the very first call (there's nothing to keep yet). */
  clientSecret?: string;
  /** Optional because the very first call happens before any user exists — nobody to attribute it to yet. */
  updatedBy?: string;
}

/**
 * Bootstrap write AND the later admin re-edit path — same function both
 * times, per its own callers: /setup (which checks getSetupStatus() first
 * and refuses to run this if already configured) and the admin-gated
 * /settings re-edit form (apps/web/src/lib/server-fns/settings.ts's
 * updateMicrosoftAuthFn, requireSystemAdmin-gated, always calls
 * invalidateAuthCache() after).
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
      microsoftClientSecretEncrypted: input.clientSecret ? encryptSecret(input.clientSecret) : null,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.systemSettings.id,
      set: {
        microsoftTenantId: input.tenantId,
        microsoftClientId: input.clientId,
        ...(input.clientSecret ? { microsoftClientSecretEncrypted: encryptSecret(input.clientSecret) } : {}),
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    });
}

/**
 * Whether userId may change DEPLOYMENT-wide config (the single
 * system_settings row: Entra, AI, embedding, mail). That row is shared by
 * every workspace, so a per-workspace role can never be the gate for it —
 * owner/admin of *some* workspace (requireSystemAdmin below) is something
 * any user could once grant themselves by creating their own workspace.
 * The deployment admin is the super admin of the founding workspace: the
 * oldest organization, i.e. the one the first-ever sign-in created (see
 * apps/web/src/lib/auth.ts's databaseHooks.user.create.after) — and the
 * flag moves with transferSuperAdmin, so it never needs a schema column of
 * its own. Reads organization/member, which carry no RLS, so the plain
 * (non-tenant) connection is enough.
 */
export async function isDeploymentAdmin(db: AnyDb, userId: string): Promise<boolean> {
  const [founding] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .orderBy(asc(schema.organization.createdAt), asc(schema.organization.id))
    .limit(1);
  if (!founding) return false;
  const [row] = await db
    .select({ isSuperAdmin: schema.member.isSuperAdmin })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, founding.id), eq(schema.member.userId, userId)));
  return row?.isSuperAdmin === true;
}

/** Throwing form of isDeploymentAdmin — the gate for every system_settings write (and its masked read). */
export async function requireDeploymentAdmin(db: AnyDb, ctx: { userId: string }) {
  if (!(await isDeploymentAdmin(db, ctx.userId))) {
    throw new ForbiddenError(`User ${ctx.userId} is not the deployment admin (super admin of the founding workspace)`);
  }
}

/**
 * A stored provider key must never be replayed against a different host:
 * if the endpoint a key is sent to changes, the caller has to re-enter the
 * key. Otherwise "leave the key blank to keep it" lets whoever can edit the
 * URL redirect the existing secret (plus every prompt) to a server they run.
 */
function assertKeyNotRetargeted(
  hasStoredKey: boolean,
  newKey: string | undefined,
  before: Record<string, string | null | undefined>,
  after: Record<string, string | null | undefined>,
) {
  if (newKey || !hasStoredKey) return;
  // `||`, not `??`: the settings form sends "" for a blank field that is stored as null.
  const changed = Object.keys(after).filter((k) => (before[k] || null) !== (after[k] || null));
  if (changed.length > 0) {
    throw new InvalidInputError(`Re-enter the API key: ${changed.join(", ")} changed, and the stored key is never sent to a new endpoint`);
  }
}

/** Whether ctx.userId is an owner/admin of ctx.organizationId — the gate for workspace-scoped /settings tabs (members, general). NOT for system_settings — see requireDeploymentAdmin. */
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
  provider: "anthropic" | "azure-openai" | "azure-foundry-anthropic" | "openai-compatible" | null;
  hasApiKey: boolean;
  model: string | null;
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
    model: row?.aiModel ?? null,
    azureEndpoint: row?.aiAzureEndpoint ?? null,
    azureDeployment: row?.aiAzureDeployment ?? null,
    openAiCompatibleBaseUrl: row?.aiOpenAiCompatibleBaseUrl ?? null,
    featuresEnabled: row?.aiFeaturesEnabled ?? false,
  };
}

export interface UpdateAiSettingsInput {
  provider: "anthropic" | "azure-openai" | "azure-foundry-anthropic" | "openai-compatible";
  /** Omit to keep the existing stored key (e.g. editing other fields without re-entering a secret). */
  apiKey?: string;
  model?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  openAiCompatibleBaseUrl?: string;
  featuresEnabled: boolean;
  updatedBy: string;
}

export async function updateAiSettings(db: AnyDb, input: UpdateAiSettingsInput) {
  const row = await getRow(db);
  assertKeyNotRetargeted(
    Boolean(row?.aiApiKeyEncrypted),
    input.apiKey,
    { provider: row?.aiProvider, azureEndpoint: row?.aiAzureEndpoint, openAiCompatibleBaseUrl: row?.aiOpenAiCompatibleBaseUrl },
    { provider: input.provider, azureEndpoint: input.azureEndpoint, openAiCompatibleBaseUrl: input.openAiCompatibleBaseUrl },
  );
  await db
    .insert(schema.systemSettings)
    .values({
      id: SYSTEM_SETTINGS_ID,
      aiProvider: input.provider,
      aiApiKeyEncrypted: input.apiKey ? encryptSecret(input.apiKey) : null,
      aiModel: input.model,
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
        aiModel: input.model,
        aiAzureEndpoint: input.azureEndpoint,
        aiAzureDeployment: input.azureDeployment,
        aiOpenAiCompatibleBaseUrl: input.openAiCompatibleBaseUrl,
        aiFeaturesEnabled: input.featuresEnabled,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    });
}

/**
 * Decrypted AI credentials for actually calling a provider
 * (packages/ai's createAiClient) — distinct from getAiSettings()'s masked
 * view, which exists only to render the admin settings UI without ever
 * echoing a stored secret back to the client. Null if AI isn't configured
 * or featuresEnabled is false — callers should treat either as "AI is
 * off", not attempt a call and handle the resulting provider error.
 */
export async function getAiCredentials(db: AnyDb) {
  const row = await getRow(db);
  if (!row?.aiProvider || !row.aiApiKeyEncrypted || !row.aiFeaturesEnabled) return null;
  return {
    provider: row.aiProvider as "anthropic" | "azure-openai" | "azure-foundry-anthropic" | "openai-compatible",
    apiKey: decryptSecret(row.aiApiKeyEncrypted),
    model: row.aiModel ?? null,
    azureEndpoint: row.aiAzureEndpoint ?? null,
    azureDeployment: row.aiAzureDeployment ?? null,
    openAiCompatibleBaseUrl: row.aiOpenAiCompatibleBaseUrl ?? null,
  };
}

export interface EmbeddingSettingsView {
  provider: "azure-openai" | "openai-compatible" | null;
  hasApiKey: boolean;
  model: string | null;
  azureEndpoint: string | null;
  azureDeployment: string | null;
  openAiCompatibleBaseUrl: string | null;
  featuresEnabled: boolean;
}

/** Masked view for /settings — same shape/reasoning as getAiSettings(), a fully independent config (see packages/db/src/schema/settings.ts's own comment on why this isn't just reusing aiProvider). */
export async function getEmbeddingSettings(db: AnyDb): Promise<EmbeddingSettingsView> {
  const row = await getRow(db);
  return {
    provider: (row?.embeddingProvider as EmbeddingSettingsView["provider"]) ?? null,
    hasApiKey: Boolean(row?.embeddingApiKeyEncrypted),
    model: row?.embeddingModel ?? null,
    azureEndpoint: row?.embeddingAzureEndpoint ?? null,
    azureDeployment: row?.embeddingAzureDeployment ?? null,
    openAiCompatibleBaseUrl: row?.embeddingOpenAiCompatibleBaseUrl ?? null,
    featuresEnabled: row?.embeddingFeaturesEnabled ?? false,
  };
}

export interface UpdateEmbeddingSettingsInput {
  provider: "azure-openai" | "openai-compatible";
  apiKey?: string;
  model?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
  openAiCompatibleBaseUrl?: string;
  featuresEnabled: boolean;
  updatedBy: string;
}

export async function updateEmbeddingSettings(db: AnyDb, input: UpdateEmbeddingSettingsInput) {
  const row = await getRow(db);
  assertKeyNotRetargeted(
    Boolean(row?.embeddingApiKeyEncrypted),
    input.apiKey,
    { provider: row?.embeddingProvider, azureEndpoint: row?.embeddingAzureEndpoint, openAiCompatibleBaseUrl: row?.embeddingOpenAiCompatibleBaseUrl },
    { provider: input.provider, azureEndpoint: input.azureEndpoint, openAiCompatibleBaseUrl: input.openAiCompatibleBaseUrl },
  );
  await db
    .insert(schema.systemSettings)
    .values({
      id: SYSTEM_SETTINGS_ID,
      embeddingProvider: input.provider,
      embeddingApiKeyEncrypted: input.apiKey ? encryptSecret(input.apiKey) : null,
      embeddingModel: input.model,
      embeddingAzureEndpoint: input.azureEndpoint,
      embeddingAzureDeployment: input.azureDeployment,
      embeddingOpenAiCompatibleBaseUrl: input.openAiCompatibleBaseUrl,
      embeddingFeaturesEnabled: input.featuresEnabled,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.systemSettings.id,
      set: {
        embeddingProvider: input.provider,
        ...(input.apiKey ? { embeddingApiKeyEncrypted: encryptSecret(input.apiKey) } : {}),
        embeddingModel: input.model,
        embeddingAzureEndpoint: input.azureEndpoint,
        embeddingAzureDeployment: input.azureDeployment,
        embeddingOpenAiCompatibleBaseUrl: input.openAiCompatibleBaseUrl,
        embeddingFeaturesEnabled: input.featuresEnabled,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    });
}

/** Decrypted embedding credentials — see getAiCredentials()'s identical reasoning. Null if not configured or disabled. */
export async function getEmbeddingCredentials(db: AnyDb) {
  const row = await getRow(db);
  if (!row?.embeddingProvider || !row.embeddingApiKeyEncrypted || !row.embeddingFeaturesEnabled) return null;
  return {
    provider: row.embeddingProvider as "azure-openai" | "openai-compatible",
    apiKey: decryptSecret(row.embeddingApiKeyEncrypted),
    model: row.embeddingModel ?? null,
    azureEndpoint: row.embeddingAzureEndpoint ?? null,
    azureDeployment: row.embeddingAzureDeployment ?? null,
    openAiCompatibleBaseUrl: row.embeddingOpenAiCompatibleBaseUrl ?? null,
  };
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

/**
 * Decrypted mail credentials for actually sending mail (packages/mail's
 * driver factory) — distinct from getMailSettings()'s masked view, which
 * exists only to render the admin settings UI without ever echoing a
 * stored secret back to the client. Null if mail isn't configured yet.
 */
export async function getMailCredentials(db: AnyDb) {
  const row = await getRow(db);
  if (!row?.mailDriver || !row.mailFrom) return null;
  return {
    driver: row.mailDriver,
    from: row.mailFrom,
    apiKey: row.mailApiKeyEncrypted ? decryptSecret(row.mailApiKeyEncrypted) : null,
    smtpUrl: row.mailSmtpUrlEncrypted ? decryptSecret(row.mailSmtpUrlEncrypted) : null,
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
  const row = await getRow(db);
  // brevo/resend keys go to a fixed vendor host, so only a driver switch retargets one.
  assertKeyNotRetargeted(Boolean(row?.mailApiKeyEncrypted), input.apiKey, { driver: row?.mailDriver }, { driver: input.driver });
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
