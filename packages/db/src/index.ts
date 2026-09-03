import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv } from "@kompast/env";
import * as schema from "./schema";

const env = loadEnv();

const client = postgres(env.DATABASE_URL);

export const db = drizzle(client, { schema });
export * as schema from "./schema";
export { withTenant } from "./tenant";

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
