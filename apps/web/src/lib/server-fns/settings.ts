import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { adminDb, and, db, eq, schema } from "@kompast/db";
import {
  getAiSettings,
  updateAiSettings,
  testAiProvider,
  testEmbeddingProvider,
  getEmbeddingStatus,
  retryFailedReindexTasks,
  getMailSettings,
  updateMailSettings,
  getMicrosoftAuthSettingsView,
  completeSetup,
  getEmbeddingSettings,
  updateEmbeddingSettings,
  enqueueFullReindex,
  requireSystemAdmin,
  requireDeploymentAdmin,
  isDeploymentAdmin,
  enqueueEmail,
  getEmailDelivery,
  withAuthorizedTenant,
  getMicrosoftAuthConfig,
  verifyMicrosoftEntraConfig,
  UserFacingError,
} from "@kompast/core";
import { requireAuthContext } from "../session";
import { invalidateAuthCache, getMicrosoftSignInStatus } from "../auth";

/**
 * Loaded by /settings for workspace owner/admins (requireSystemAdmin). The
 * deployment-wide integration config (system_settings) is only included
 * for the deployment admin (requireDeploymentAdmin) — a workspace owner
 * still gets the workspace tabs, just not the global ones.
 */
export const getIntegrationSettingsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  await requireSystemAdmin(db, ctx);
  const [member, canManageIntegrations] = await Promise.all([
    db
      .select({ isSuperAdmin: schema.member.isSuperAdmin })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId)))
      .then((rows) => rows[0]),
    isDeploymentAdmin(db, ctx.userId),
  ]);
  const global = canManageIntegrations
    ? await Promise.all([
        getAiSettings(db),
        getMailSettings(db),
        getMicrosoftAuthSettingsView(db),
        getEmbeddingSettings(db),
        getMicrosoftSignInStatus(),
      ]).then(([ai, mail, entra, embedding, signInStatus]) => ({ ai, mail, entra: { ...entra, signInStatus }, embedding }))
    : null;
  const [me] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, ctx.userId));
  return { global, isSuperAdmin: member?.isSuperAdmin ?? false, userEmail: me?.email ?? "" };
});

const updateMicrosoftAuthSchema = z.object({
  tenantId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Must be a Microsoft Entra tenant GUID"),
  clientId: z.string().min(1),
  /** Omit to keep the existing stored secret — see completeSetup's own doc comment. */
  clientSecret: z.string().min(1).optional(),
});

/**
 * The secret to check Entra settings with: the one just typed, or on a re-edit
 * with a blank field, the one already stored. Null when there is neither.
 */
async function entraSecretToCheck(submitted: string | undefined): Promise<string | null> {
  if (submitted) return submitted;
  return (await getMicrosoftAuthConfig(db))?.clientSecret ?? null;
}

/**
 * The admin-gated re-edit path setup.ts's completeSetupFn's own doc
 * comment already pointed to ("see /settings"). The submitted settings are
 * first checked with Microsoft (verifyMicrosoftEntraConfig), and a rejected
 * value is refused before anything is written. Then it calls the exact same
 * completeSetup() the one-time /setup wizard uses, which is safe to call again
 * by design, and invalidates the cached Better Auth instance so the very next
 * request rebuilds it with the new credentials, no restart needed.
 */
export const updateMicrosoftAuthFn = createServerFn({ method: "POST" })
  .validator(updateMicrosoftAuthSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);
    const clientSecret = await entraSecretToCheck(data.clientSecret);
    if (!clientSecret) throw new UserFacingError("Enter the client secret.");
    const check = await verifyMicrosoftEntraConfig({ tenantId: data.tenantId, clientId: data.clientId, clientSecret });
    if (!check.ok) throw new UserFacingError(check.message);
    await completeSetup(db, { ...data, updatedBy: ctx.userId });
    invalidateAuthCache();
    return { ok: true, warning: check.warning } as const;
  });

/**
 * The "Test connection" button on the Entra section. It runs the same check as
 * updateMicrosoftAuthFn but saves nothing. It returns the result instead of
 * throwing, so the form can show Microsoft's own message next to the fields.
 */
export const testMicrosoftAuthFn = createServerFn({ method: "POST" })
  .validator(updateMicrosoftAuthSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);
    const clientSecret = await entraSecretToCheck(data.clientSecret);
    if (!clientSecret) return { ok: false, field: "clientSecret", message: "Enter the client secret." } as const;
    return verifyMicrosoftEntraConfig({ tenantId: data.tenantId, clientId: data.clientId, clientSecret });
  });

const updateAiSchema = z.object({
  provider: z.enum(["anthropic", "azure-openai", "azure-foundry-anthropic", "openai-compatible"]),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  azureEndpoint: z.string().optional(),
  azureDeployment: z.string().optional(),
  openAiCompatibleBaseUrl: z.string().optional(),
  featuresEnabled: z.boolean(),
});

export const updateAiSettingsFn = createServerFn({ method: "POST" })
  .validator(updateAiSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);
    await updateAiSettings(db, { ...data, updatedBy: ctx.userId });
    return { ok: true } as const;
  });

const updateEmbeddingSchema = z.object({
  provider: z.enum(["azure-openai", "openai-compatible"]),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  azureEndpoint: z.string().optional(),
  azureDeployment: z.string().optional(),
  openAiCompatibleBaseUrl: z.string().optional(),
  featuresEnabled: z.boolean(),
});

/** No "anthropic" option here at all — see packages/db/src/schema/settings.ts's comment on why the embedding provider is a fully separate choice from the chat provider. */
export const updateEmbeddingSettingsFn = createServerFn({ method: "POST" })
  .validator(updateEmbeddingSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);
    await updateEmbeddingSettings(db, { ...data, updatedBy: ctx.userId });
    return { ok: true } as const;
  });

/**
 * Queues every issue, comment and page in the workspace for reindexing (see
 * enqueueFullReindex). Runs on adminDb because a workspace admin's own RLS
 * may not show them every team's content. The queue is drained by apps/worker.
 */
export const reindexAllFn = createServerFn({ method: "POST" }).handler(async () => {
  const ctx = await requireAuthContext();
  await requireSystemAdmin(db, ctx);
  const counts = await enqueueFullReindex(adminDb, ctx.organizationId);
  return { ok: true, ...counts } as const;
});

/**
 * Test connection for the AI config, sent with the form's current values so it
 * works before Save. Every field is optional here; the handler only builds
 * overrides when a provider is sent. Provider failures come back as { ok: false }
 * rather than a thrown error, because the global error middleware hides
 * unknown errors. The admin owns this config, so the provider's status and
 * body are shown. The API key is masked in core.
 */
const testAiSchema = updateAiSchema.partial();

export const testAiProviderFn = createServerFn({ method: "POST" })
  .validator(testAiSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);
    const overrides = data.provider
      ? {
          provider: data.provider,
          apiKey: data.apiKey,
          model: data.model,
          azureEndpoint: data.azureEndpoint,
          azureDeployment: data.azureDeployment,
          openAiCompatibleBaseUrl: data.openAiCompatibleBaseUrl,
        }
      : undefined;
    return testAiProvider(db, overrides);
  });

const testEmbeddingSchema = updateEmbeddingSchema.partial();

/** Same as testAiProviderFn, for the embedding config. Also checks the vector dimension (see testEmbeddingConnection). */
export const testEmbeddingProviderFn = createServerFn({ method: "POST" })
  .validator(testEmbeddingSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);
    const overrides = data.provider
      ? {
          provider: data.provider,
          apiKey: data.apiKey,
          model: data.model,
          azureEndpoint: data.azureEndpoint,
          azureDeployment: data.azureDeployment,
          openAiCompatibleBaseUrl: data.openAiCompatibleBaseUrl,
        }
      : undefined;
    return testEmbeddingProvider(db, overrides);
  });

/**
 * Indexing progress for Settings → Embedding. Gated like reindexAllFn (workspace
 * owner/admin), and read on adminDb for the same reason: the counts cover the
 * whole workspace, not only what this user's RLS shows.
 */
export const getEmbeddingStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  await requireSystemAdmin(db, ctx);
  return getEmbeddingStatus(adminDb, ctx.organizationId);
});

/** Puts this workspace's failed reindex tasks back in the queue (see retryFailedReindexTasks). */
export const retryFailedReindexFn = createServerFn({ method: "POST" }).handler(async () => {
  const ctx = await requireAuthContext();
  await requireSystemAdmin(db, ctx);
  const reset = await retryFailedReindexTasks(adminDb, ctx.organizationId);
  return { ok: true, reset } as const;
});

const updateMailSchema = z.object({
  driver: z.enum(["brevo", "resend", "smtp"]),
  from: z.email(),
  apiKey: z.string().optional(),
  smtpUrl: z.string().optional(),
});

export const updateMailSettingsFn = createServerFn({ method: "POST" })
  .validator(updateMailSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);
    await updateMailSettings(db, { ...data, updatedBy: ctx.userId });
    return { ok: true } as const;
  });

const sendTestEmailSchema = z.object({ to: z.email().optional() });

/**
 * Queues a test email through the real outbox rather than calling the vendor
 * directly, so the test covers saved credentials, the running worker and the
 * vendor's acceptance, the same path as every invitation. Poll
 * getTestEmailStatusFn with the returned outboxId for the result.
 */
export const sendTestEmailFn = createServerFn({ method: "POST" })
  .validator(sendTestEmailSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);

    let to = data.to;
    if (!to) {
      const [me] = await db.select({ email: schema.user.email }).from(schema.user).where(eq(schema.user.id, ctx.userId));
      to = me?.email;
    }
    if (!to) throw new UserFacingError("No recipient address for the test email");

    const { outboxId } = await withAuthorizedTenant(ctx, (tx) =>
      enqueueEmail(tx, {
        organizationId: ctx.organizationId,
        to,
        subject: "Kompast test email",
        templateKey: "notification",
        templateProps: {
          title: "Kompast test email",
          body: "If you can read this, Kompast mail delivery works.",
        },
        dedupeKey: `test:${crypto.randomUUID()}`,
      }),
    );
    return { outboxId };
  });

/** Delivery state of a test email queued by sendTestEmailFn (null if the row no longer exists). */
export const getTestEmailStatusFn = createServerFn({ method: "GET" })
  .validator((outboxId: string) => outboxId)
  .handler(async ({ data: outboxId }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);
    return withAuthorizedTenant(ctx, (tx) => getEmailDelivery(tx, outboxId));
  });
