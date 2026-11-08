import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { adminDb, and, db, eq, schema } from "@kompast/db";
import {
  getAiSettings,
  updateAiSettings,
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
} from "@kompast/core";
import { requireAuthContext } from "../session";
import { invalidateAuthCache } from "../auth";

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
    ? await Promise.all([getAiSettings(db), getMailSettings(db), getMicrosoftAuthSettingsView(db), getEmbeddingSettings(db)]).then(
        ([ai, mail, entra, embedding]) => ({ ai, mail, entra, embedding }),
      )
    : null;
  return { global, isSuperAdmin: member?.isSuperAdmin ?? false };
});

const updateMicrosoftAuthSchema = z.object({
  tenantId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Must be a Microsoft Entra tenant GUID"),
  clientId: z.string().min(1),
  /** Omit to keep the existing stored secret — see completeSetup's own doc comment. */
  clientSecret: z.string().min(1).optional(),
});

/**
 * The admin-gated re-edit path setup.ts's completeSetupFn's own doc
 * comment already pointed to ("see /settings"). Calls the exact same
 * completeSetup() the one-time /setup wizard uses — safe to call again by
 * design — then invalidates the cached Better Auth instance so the very
 * next request rebuilds it with the new credentials, no restart needed.
 */
export const updateMicrosoftAuthFn = createServerFn({ method: "POST" })
  .validator(updateMicrosoftAuthSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireDeploymentAdmin(db, ctx);
    await completeSetup(db, { ...data, updatedBy: ctx.userId });
    invalidateAuthCache();
    return { ok: true } as const;
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
