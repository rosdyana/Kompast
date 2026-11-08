import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv } from "@kompast/env";
import * as schema from "./schema";

const env = loadEnv();

const client = postgres(env.DATABASE_URL);

export const db = drizzle(client, { schema });

/**
 * Bypasses RLS — NOT the general-purpose escape hatch its name suggests.
 * The legitimate callers are the documented cross-tenant paths: apps/collab
 * (Yjs persistence, authenticated by a signed per-page token with no
 * workspace session to derive a GUC from), packages/core/share-link.ts (the
 * public guest route, no session by design — plan §Auth, "Guests are not
 * sessions"), and the worker's system-wide queue claims / JIRA migration
 * runner. Every other query goes through `db` +
 * withTenant()/withAuthorizedTenant(). Reaching for this to "make an RLS
 * error go away" is the bug, not the fix.
 *
 * Connects as the SERVICE role (DATABASE_SERVICE_URL): BYPASSRLS plus
 * data-only grants, not a superuser — so a bug in one of these paths can
 * read/write rows, but can't run DDL, read server files, or `COPY ...
 * PROGRAM`. Falls back to DATABASE_ADMIN_URL only when no service URL is
 * configured (dev, tests, installs from before the role split).
 */
const serviceUrl = env.DATABASE_SERVICE_URL ?? env.DATABASE_ADMIN_URL;
if (!serviceUrl) {
  throw new Error("DATABASE_SERVICE_URL is required (or, for local dev and tests, DATABASE_ADMIN_URL). See infra/.env.example.");
}
export const adminDb = drizzle(postgres(serviceUrl), { schema });
export * as schema from "./schema";
export { withTenant } from "./tenant";
export type { Json } from "./schema/_shared";
export { SYSTEM_SETTINGS_ID } from "./schema/settings";

/**
 * Every drizzle-orm operator (eq, and, inArray, ...) callers need,
 * re-exported from THIS package's own resolved copy. better-auth
 * unconditionally depends on every one of its adapter packages
 * (drizzle/kysely/prisma/mongo/memory), each with its own driver peer
 * deps, so pnpm resolves more than one nominally-distinct drizzle-orm
 * instance in this workspace. TypeScript treats them as incompatible
 * types (SQL's private `shouldInlineParams` field differs by instance)
 * even at the same version. Importing operators from `drizzle-orm`
 * directly elsewhere risks pulling the wrong instance; importing them from
 * here guarantees the same instance that built `schema`'s columns.
 */
export * from "drizzle-orm";
