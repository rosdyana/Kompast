import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { db } from "@kompast/db";
import { getSetupStatus, completeSetup } from "@kompast/core";
import { invalidateAuthCache } from "../auth";

export const getSetupStatusFn = createServerFn({ method: "GET" }).handler(() => getSetupStatus(db));

const completeSetupSchema = z.object({
  tenantId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Must be a Microsoft Entra tenant GUID"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

/**
 * Deliberately unauthenticated — this is what BOOTSTRAPS auth in the first
 * place, so there's no session to require yet. The only guard is
 * `getSetupStatus` itself: once Microsoft auth is configured, this refuses
 * to run again, so a public, unauthenticated endpoint can't be used to
 * hijack an already-running deployment. Re-editing Entra config after that
 * point is a separate, admin-gated path (see /settings, packages/core's
 * requireSystemAdmin), not this one.
 */
export const completeSetupFn = createServerFn({ method: "POST" })
  .validator(completeSetupSchema)
  .handler(async ({ data }) => {
    const status = await getSetupStatus(db);
    if (status.isConfigured) {
      throw new Error("Setup has already run. Use workspace settings to change Microsoft Entra ID configuration.");
    }
    await completeSetup(db, data);
    invalidateAuthCache();
    return { ok: true } as const;
  });
