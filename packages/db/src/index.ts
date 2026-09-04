import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv } from "@kompast/env";
import * as schema from "./schema";

const env = loadEnv();

const client = postgres(env.DATABASE_URL);

export const db = drizzle(client, { schema });

/**
 * Bypasses RLS entirely (table owner) — NOT the general-purpose escape
 * hatch its name suggests. There are exactly two legitimate callers:
 * apps/collab (Yjs persistence, authenticated by a signed per-page token
 * with no workspace session to derive a GUC from) and
 * packages/core/share-link.ts (the public guest route, which by design
 * has no session at all — see plan §Auth, "Guests are not sessions").
 * Every other query goes through `db` + withTenant()/withAuthorizedTenant().
 * Reaching for this to "make an RLS error go away" is the bug, not the fix.
 */
export const adminDb = drizzle(postgres(env.DATABASE_ADMIN_URL), { schema });
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
