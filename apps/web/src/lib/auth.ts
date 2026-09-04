import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { genericOAuth, microsoftEntraId } from "better-auth/plugins/generic-oauth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { apiKey } from "@better-auth/api-key";
import { loadEnv } from "@kompast/env";
import { db, schema, eq } from "@kompast/db";
import { getMicrosoftAuthConfig, isOnlyUser } from "@kompast/core";

const env = loadEnv();

/**
 * Lazily built, cached Better Auth instance — NOT a static top-level
 * export. Microsoft Entra ID credentials live in system_settings (DB),
 * configured through /setup, not in .env (see plan pivot: minimize .env
 * for a SaaS deploy, LLM/mail/Entra config all move to admin UI). Better
 * Auth has no way to swap a plugin's config after construction, so instead
 * of restarting the process every time an admin edits Entra config, this
 * rebuilds the instance in-memory and swaps the cache the next time
 * `getAuth()` is called after `invalidateAuthCache()` — zero downtime, one
 * process, no restart. If this ever scales to >1 web instance, the cache
 * invalidation needs to be broadcast (e.g. Redis pub/sub); for a single
 * container this in-memory flag is enough.
 *
 * Before setup completes, `getMicrosoftAuthConfig` returns null and the
 * genericOAuth plugin is simply omitted — NOT included with empty/invalid
 * credentials. Constructing `microsoftEntraId()` with a blank tenant throws
 * immediately (it validates the tenant is a real GUID), and even a
 * syntactically valid but wrong tenant would only fail later, opaquely,
 * inside Better Auth's own plugin init. Omitting the plugin entirely means
 * "Microsoft sign-in isn't configured yet" fails obviously (no such
 * provider) rather than crashing the whole auth context.
 */
let cached: { auth: ReturnType<typeof buildAuth>; configured: boolean } | null = null;

export async function getAuth() {
  const microsoft = await getMicrosoftAuthConfig(db);
  const configured = microsoft !== null;

  if (cached && cached.configured === configured) return cached.auth;

  const auth = buildAuth(microsoft);
  cached = { auth, configured };
  return auth;
}

/** Called right after /setup (or the future admin Entra-settings screen) writes new credentials. */
export function invalidateAuthCache() {
  cached = null;
}

function buildAuth(microsoft: Awaited<ReturnType<typeof getMicrosoftAuthConfig>>) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    databaseHooks: {
      user: {
        create: {
          // First-ever sign-in across the whole deployment becomes the
          // owner of a brand-new workspace — every subsequent sign-in is a
          // plain JIT-provisioned user with no organization until an
          // existing admin invites them (see plan §"REST API + MCP"-style
          // "single enforcement point" principle: this is the one place
          // that decision gets made, not scattered across routes).
          after: async (newUser) => {
            if (!(await isOnlyUser(db, newUser.id))) return;
            const seedAuth = betterAuth({
              baseURL: env.BETTER_AUTH_URL,
              secret: env.BETTER_AUTH_SECRET,
              database: drizzleAdapter(db, { provider: "pg", schema }),
              plugins: [organization({ teams: { enabled: true } })],
            });
            await seedAuth.api.createOrganization({
              body: {
                name: newUser.name || newUser.email,
                slug: `ws-${newUser.id.slice(0, 12)}`,
                userId: newUser.id,
              },
            });
          },
        },
      },
      session: {
        create: {
          // Better Auth never auto-populates activeOrganizationId — it's
          // only ever set via an explicit /organization/set-active call.
          // Auto-select it here when the signing-in user belongs to
          // exactly one organization (true for the bootstrap owner, and
          // for anyone invited to a single workspace — the common case
          // until multi-workspace switching UI exists). Leaves it null,
          // deliberately, for a user in zero or multiple orgs; the
          // zero case surfaces as "no workspace" in the UI, and picking
          // among several is a follow-up, not built yet.
          before: async (newSession) => {
            if (newSession.activeOrganizationId) return;
            const memberships = await db
              .select({ organizationId: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, newSession.userId));
            if (memberships.length !== 1) return;
            return { data: { activeOrganizationId: memberships[0]!.organizationId } };
          },
        },
      },
    },
    plugins: [
      organization({
        teams: { enabled: true },
      }),
      ...(microsoft
        ? [
            genericOAuth({
              config: [
                microsoftEntraId({
                  clientId: microsoft.clientId,
                  clientSecret: microsoft.clientSecret,
                  tenantId: microsoft.tenantId,
                }),
              ],
            }),
          ]
        : []),
      // REST API + MCP both authenticate against this table (plan §"REST API
      // + MCP" — PAT-only in v1, no OAuth connector flow). The token
      // management UI itself is P3; the plugin is registered now because its
      // schema needs to exist before any token can be minted.
      apiKey({
        references: "user",
        // Workspace binding (which org a token can act in) lives in this
        // column, not the plugin's own `organizationId` field — that field
        // only applies when references: "organization", and every token
        // here is issued to a user. See apps/web/src/lib/api-auth.ts.
        enableMetadata: true,
        permissions: {
          defaultPermissions: {},
        },
      }),
      tanstackStartCookies(),
    ],
  });
}
