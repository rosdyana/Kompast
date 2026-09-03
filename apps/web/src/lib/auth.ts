import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { genericOAuth, microsoftEntraId } from "better-auth/plugins/generic-oauth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { apiKey } from "@better-auth/api-key";
import { loadEnv } from "@kompast/env";
import { db, schema } from "@kompast/db";

const env = loadEnv();

/**
 * Server-side Better Auth instance. `organization` IS our workspace model
 * (see plan: "Multi-workspace from day one") — never build a parallel
 * workspace table. `microsoftEntraId` is the plugin's dedicated Entra ID
 * helper (better-auth/plugins/generic-oauth), not a hand-rolled OIDC
 * discovery config.
 *
 * Before the first migration, run
 * `pnpm --filter @kompast/web exec better-auth generate` and diff the
 * result against packages/db/src/schema/auth.ts — plugin schemas gain
 * columns across minor versions and that command is the source of truth,
 * not this file's comments.
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  plugins: [
    organization({
      teams: { enabled: true },
    }),
    genericOAuth({
      config: [
        microsoftEntraId({
          clientId: env.MICROSOFT_CLIENT_ID,
          clientSecret: env.MICROSOFT_CLIENT_SECRET,
          tenantId: env.MICROSOFT_TENANT_ID,
        }),
      ],
    }),
    // REST API + MCP both authenticate against this table (plan §"REST API
    // + MCP" — PAT-only in v1, no OAuth connector flow). The token
    // management UI itself is P3; the plugin is registered now because its
    // schema needs to exist before any token can be minted.
    apiKey({
      references: "user",
      permissions: {
        defaultPermissions: {},
      },
    }),
    tanstackStartCookies(),
  ],
});
