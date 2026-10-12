import { createServerFn } from "@tanstack/react-start";
import { db, inArray, schema } from "@kompast/db";
import { getSetupStatus } from "@kompast/core";
import { loadEnv } from "@kompast/env";
import { getDevAdminConfig } from "../auth";
import { DEMO_PERSONAS, getDemoConfig } from "../demo";

/**
 * Deliberately unauthenticated, like getSetupStatusFn — the login page (and
 * the root route's /setup gate) need this before any session exists.
 * `enabled` is the local-only dev-admin bypass (getDevAdminConfig); `demo`
 * is stakeholder-demo mode (lib/demo.ts). Never returns the demo access
 * code — only which seeded personas actually exist to offer.
 */
export const getDevLoginStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  const env = loadEnv();
  const demo = getDemoConfig(env);
  const seeded = demo.enabled
    ? new Set(
        (await db.select({ email: schema.user.email }).from(schema.user).where(inArray(schema.user.email, DEMO_PERSONAS.map((p) => p.email)))).map((u) => u.email),
      )
    : new Set<string>();
  return {
    enabled: getDevAdminConfig(env).enabled,
    microsoftConfigured: (await getSetupStatus(db)).isConfigured,
    demo: { enabled: demo.enabled, personas: DEMO_PERSONAS.filter((p) => seeded.has(p.email)) },
  };
});
