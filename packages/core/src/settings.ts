import { createHash, timingSafeEqual } from "node:crypto";
import { and, asc, eq, schema, SYSTEM_SETTINGS_ID, withTenant } from "@kompast/db";
import type { db as appDb } from "@kompast/db";
import type { AnyDb } from "./types";
import { encryptSecret, decryptSecret } from "./crypto";
import { ForbiddenError } from "./permissions";
import { InvalidInputError } from "./errors";
import { id } from "./ids";
import type { AiCredentials, EmbeddingCredentials } from "@kompast/ai";

type SystemSettingsRow = typeof schema.systemSettings.$inferSelect;

const MICROSOFT_TENANT_GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getRow(db: AnyDb) {
  const [row] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.id, SYSTEM_SETTINGS_ID));
  return row ?? null;
}

/** The raw singleton row, for the Test connection helpers in ai.ts and rag.ts — they need the stored fields before the featuresEnabled gate applies. */
export async function getSystemSettingsRow(db: AnyDb): Promise<SystemSettingsRow | null> {
  return getRow(db);
}

export async function getSetupStatus(db: AnyDb) {
  const row = await getRow(db);
  return {
    isConfigured: Boolean(row?.microsoftTenantId && row.microsoftClientId && row.microsoftClientSecretEncrypted),
    /** An unexpired `kompast sso-reset` code is waiting to be used on /setup. */
    recoveryPending: Boolean(row?.ssoRecoveryCodeHash && row.ssoRecoveryExpiresAt && row.ssoRecoveryExpiresAt > new Date()),
  };
}

export type EntraVerifyResult =
  | { ok: true; warning?: string }
  | { ok: false; field: "tenantId" | "clientId" | "clientSecret" | null; message: string };

const ENTRA_CHECK_TIMEOUT_MS = 5000;

function describeFetchError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Checks a Tenant ID, Client ID and secret against Microsoft before they are saved (/setup and /settings), so a
 * typo is caught at the form instead of locking everyone out of sign-in later. Two calls, both with a 5s timeout:
 * the tenant's OIDC discovery document (unknown tenants get a 400), then a client-credentials token request, which
 * is the only place Microsoft says whether the app is registered in that tenant and whether the secret is good.
 * Only the errors that mean "this value is wrong" block the save. Any other token error is returned as a warning,
 * because some tenants restrict the client-credentials grant. Microsoft's own error_description is shown in the
 * message, with the secret masked.
 */
export async function verifyMicrosoftEntraConfig(
  input: { tenantId: string; clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<EntraVerifyResult> {
  if (!MICROSOFT_TENANT_GUID_RE.test(input.tenantId)) {
    return { ok: false, field: "tenantId", message: "Microsoft Tenant ID must be a concrete tenant GUID." };
  }
  const authority = `https://login.microsoftonline.com/${input.tenantId}`;
  const unreachable = (err: unknown): EntraVerifyResult => ({
    ok: false,
    field: null,
    message: `Couldn't reach Microsoft to check the tenant: ${describeFetchError(err)}`,
  });

  let discovery: Response;
  try {
    discovery = await fetchImpl(`${authority}/v2.0/.well-known/openid-configuration`, { signal: AbortSignal.timeout(ENTRA_CHECK_TIMEOUT_MS) });
  } catch (err) {
    return unreachable(err);
  }
  if (!discovery.ok) return { ok: false, field: "tenantId", message: "Microsoft doesn't recognize this tenant ID." };

  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  let token: Response;
  try {
    token = await fetchImpl(`${authority}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(ENTRA_CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    return unreachable(err);
  }
  if (token.ok) return { ok: true };

  const body = (await token.json().catch(() => null)) as { error_description?: unknown } | null;
  const description = typeof body?.error_description === "string" ? body.error_description : "";
  if (description.includes("AADSTS700016")) {
    return { ok: false, field: "clientId", message: "This application (client) ID isn't registered in that tenant." };
  }
  if (description.includes("AADSTS7000215")) return { ok: false, field: "clientSecret", message: "The client secret is wrong." };
  if (description.includes("AADSTS7000222")) return { ok: false, field: "clientSecret", message: "The client secret has expired." };

  const firstLine = redactSecret(description.split(/\r?\n/)[0] ?? "", input.clientSecret).trim() || `HTTP ${token.status}`;
  return { ok: true, warning: `Tenant found, but Microsoft refused a test token: ${firstLine}` };
}

/** SHA-256 hex of a recovery code. infra/install.sh's `kompast sso-reset` computes the same value with `sha256sum`, so the two must stay identical. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

/**
 * Uses a `kompast sso-reset` code to open /setup once, and saves the Entra settings the admin submitted. The current
 * sign-in config stays live until this runs. The code is compared in constant time, and it is single-use and expires
 * after 30 minutes. The hash is cleared in the same transaction as the Entra write. Returns false for a wrong, expired,
 * consumed or never-issued code, and then nothing is written. A success is audited in the founding workspace,
 * because audit_log.organization_id is NOT NULL.
 */
export async function completeSsoRecovery(
  db: typeof appDb,
  input: { code: string; tenantId: string; clientId: string; clientSecret: string },
): Promise<boolean> {
  const [founding] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .orderBy(asc(schema.organization.createdAt), asc(schema.organization.id))
    .limit(1);
  // No workspace yet means nobody has signed in (e.g. a typo at first setup): recover without an audit row, since
  // audit_log needs a workspace to belong to.
  const run = <T>(fn: (tx: Parameters<Parameters<typeof appDb.transaction>[0]>[0]) => Promise<T>) =>
    founding ? withTenant(db, { organizationId: founding.id, userId: null }, fn) : db.transaction(fn);

  return run(async (tx) => {
    const [row] = await tx.select().from(schema.systemSettings).where(eq(schema.systemSettings.id, SYSTEM_SETTINGS_ID)).for("update");
    const stored = row?.ssoRecoveryCodeHash;
    if (!stored || !row?.ssoRecoveryExpiresAt || row.ssoRecoveryExpiresAt <= new Date()) return false;
    const expected = Buffer.from(stored, "hex");
    const given = Buffer.from(hashRecoveryCode(input.code), "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;

    await completeSetup(tx, { tenantId: input.tenantId, clientId: input.clientId, clientSecret: input.clientSecret });
    await tx
      .update(schema.systemSettings)
      .set({ ssoRecoveryCodeHash: null, ssoRecoveryExpiresAt: null })
      .where(eq(schema.systemSettings.id, SYSTEM_SETTINGS_ID));
    if (!founding) return true;
    await tx.insert(schema.auditLog).values({
      id: id("audit"),
      organizationId: founding.id,
      actorId: null,
      origin: "user",
      action: "sso.recovered",
      entityType: "system_settings",
      entityId: SYSTEM_SETTINGS_ID,
      metadata: JSON.stringify({ tenantId: input.tenantId, clientId: input.clientId }),
    });
    return true;
  });
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

/**
 * Masks the API key wherever a provider echoes it back (an error body, a
 * message). A blank key is skipped: split("") would put the mask between every
 * character.
 */
export function redactSecret(text: string, secret: string | null | undefined): string {
  return secret ? text.split(secret).join("••••") : text;
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
export function assertKeyNotRetargeted(
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
export async function getAiCredentials(db: AnyDb): Promise<AiCredentials | null> {
  const row = await getRow(db);
  if (!row?.aiProvider || !row.aiApiKeyEncrypted || !row.aiFeaturesEnabled) return null;
  return aiCredentialsFromRow(row);
}

/**
 * Decrypted AI credentials from a stored row, with NO featuresEnabled gate.
 * Shared by getAiCredentials (real calls) and testAiProvider (Test connection
 * must work before the toggle is switched on), so the decrypt/mapping lives once.
 */
export function aiCredentialsFromRow(row: SystemSettingsRow): AiCredentials {
  return {
    provider: row.aiProvider as AiCredentials["provider"],
    apiKey: row.aiApiKeyEncrypted ? decryptSecret(row.aiApiKeyEncrypted) : null,
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
export async function getEmbeddingCredentials(db: AnyDb): Promise<EmbeddingCredentials | null> {
  const row = await getRow(db);
  if (!row?.embeddingProvider || !row.embeddingApiKeyEncrypted || !row.embeddingFeaturesEnabled) return null;
  return embeddingCredentialsFromRow(row);
}

/** Embedding twin of aiCredentialsFromRow — no featuresEnabled gate, shared with testEmbeddingProvider. */
export function embeddingCredentialsFromRow(row: SystemSettingsRow): EmbeddingCredentials {
  return {
    provider: row.embeddingProvider as EmbeddingCredentials["provider"],
    apiKey: row.embeddingApiKeyEncrypted ? decryptSecret(row.embeddingApiKeyEncrypted) : null,
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
