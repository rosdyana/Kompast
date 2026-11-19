import { createHash, timingSafeEqual } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import * as z from "zod";
import { db } from "@kompast/db";
import { getSetupStatus, completeSetup, completeSsoRecovery, hasAnyUser, verifyMicrosoftEntraConfig, UserFacingError } from "@kompast/core";
import { loadEnv } from "@kompast/env";
import { invalidateAuthCache, getDevAdminConfig } from "../auth";
import { getDemoConfig } from "../demo";
import { clientIp, rateLimit } from "../rate-limit";

export const getSetupStatusFn = createServerFn({ method: "GET" }).handler(async () => ({
  ...(await getSetupStatus(db)),
  requiresSetupToken: Boolean(loadEnv().SETUP_TOKEN),
  /** Whether any user exists yet. /setup shows the recovery code field once users exist. */
  hasUsers: await hasAnyUser(db),
}));

function setupTokenMatches(expected: string, given: string | undefined): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

const completeSetupSchema = z.object({
  tenantId: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Must be a Microsoft Entra tenant GUID"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  setupToken: z.string().optional(),
  /** Printed by `kompast sso-reset` on the server. Required to reopen /setup once sign-in is configured. */
  recoveryCode: z.string().optional(),
});

/**
 * Deliberately unauthenticated — this is what BOOTSTRAPS auth in the first
 * place, so there's no session to require yet. The only guard is
 * `getSetupStatus` itself: once Microsoft auth is configured, this refuses
 * to run again, so a public, unauthenticated endpoint can't be used to
 * hijack an already-running deployment. Re-editing Entra config after that
 * point is a separate, deployment-admin-gated path (see /settings,
 * packages/core's requireDeploymentAdmin), not this one.
 *
 * Also refused (whoever submits first would otherwise choose the Entra
 * tenant, and that tenant's first sign-in becomes the founding super
 * admin): in DEMO_MODE, where Entra is never configured so this endpoint
 * would stay open forever; and once any user exists, unless local dev
 * login is on (a dev testing /setup against their own dev-admin user).
 *
 * Before anything is saved, the submitted Tenant ID, Client ID and secret are
 * checked with Microsoft (verifyMicrosoftEntraConfig). A value Microsoft
 * rejects is refused with its message, so a typo never reaches system_settings.
 *
 * Recovery: `kompast sso-reset` on the server writes a one-time code (stored
 * hashed, valid 30 minutes). When a recovery code is submitted, it is checked
 * by completeSsoRecovery, and it is the only way past the "already configured"
 * and "users exist" refusals above. The current sign-in config stays live until
 * a recovery succeeds. A wrong, expired or already-used code is refused, and
 * nothing is written.
 */
export const completeSetupFn = createServerFn({ method: "POST" })
  .validator(completeSetupSchema)
  .handler(async ({ data }) => {
    // Unauthenticated until setup completes, so cap attempts per IP.
    const gate = await rateLimit(`setup:${clientIp(getRequest())}`, 10, 900);
    if (!gate.ok) throw new UserFacingError(`Too many setup attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`);
    const env = loadEnv();
    if (env.SETUP_TOKEN && !setupTokenMatches(env.SETUP_TOKEN, data.setupToken)) throw new UserFacingError("The setup token is missing or wrong.");
    if (getDemoConfig(env).enabled) throw new UserFacingError("Setup is disabled in demo mode.");

    const recoveryFailed = "The recovery code is wrong or has expired. Run `kompast sso-reset` again on the server.";
    // Cheap refusals first, so this unauthenticated endpoint only calls Microsoft for a request that could succeed.
    const status = await getSetupStatus(db);
    if (data.recoveryCode) {
      if (!status.recoveryPending) throw new UserFacingError(recoveryFailed);
    } else {
      if (status.isConfigured) {
        throw new UserFacingError("Setup has already run. Use workspace settings to change Microsoft Entra ID configuration, or run `kompast sso-reset` on the server.");
      }
      if ((await hasAnyUser(db)) && !getDevAdminConfig(env).enabled) {
        throw new UserFacingError("This deployment already has users. Ask its admin to configure Microsoft Entra ID in workspace settings, or run `kompast sso-reset` on the server.");
      }
    }

    const check = await verifyMicrosoftEntraConfig({ tenantId: data.tenantId, clientId: data.clientId, clientSecret: data.clientSecret });
    if (!check.ok) throw new UserFacingError(check.message);

    if (data.recoveryCode) {
      const recovered = await completeSsoRecovery(db, {
        code: data.recoveryCode,
        tenantId: data.tenantId,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
      });
      if (!recovered) throw new UserFacingError(recoveryFailed);
      invalidateAuthCache();
      return { ok: true, warning: check.warning } as const;
    }

    await completeSetup(db, { tenantId: data.tenantId, clientId: data.clientId, clientSecret: data.clientSecret });
    invalidateAuthCache();
    return { ok: true, warning: check.warning } as const;
  });
