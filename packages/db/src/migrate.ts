import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv } from "@kompast/env";
import { bootstrapAppRole, bootstrapServiceRole } from "./bootstrap-roles";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const env = loadEnv();
  const adminUrl = env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("DATABASE_ADMIN_URL is required to run migrations (the owning/superuser connection).");

  // 1. Schema migrations, as the owning/admin role.
  const adminClient = postgres(adminUrl, { max: 1 });
  const db = drizzle(adminClient);

  // Must run before any migration that creates a vector(...) column (the
  // embedding table, P7 stage 2) — the type doesn't exist until this
  // extension is installed. Requires the pgvector extension to actually be
  // present in the Postgres image (pgvector/pgvector:pgXX, not vanilla
  // postgres:XX-alpine) — see infra/docker-compose.yml.
  await adminClient.unsafe("CREATE EXTENSION IF NOT EXISTS vector;");

  await migrate(db, { migrationsFolder: join(__dirname, "..", "drizzle") });
  console.log("Migrations applied.");

  // 2. The restricted role the app actually connects as (DATABASE_URL) —
  // must exist with correct grants before RLS policies mean anything.
  await bootstrapAppRole(adminUrl, env.DATABASE_URL);
  console.log("App role bootstrapped.");

  // 2b. The RLS-exempt service role the running app uses instead of the
  // superuser (packages/db's adminDb). Skipped when DATABASE_SERVICE_URL is
  // unset — the app then falls back to DATABASE_ADMIN_URL (dev/tests).
  if (env.DATABASE_SERVICE_URL) {
    await bootstrapServiceRole(adminUrl, env.DATABASE_SERVICE_URL, [env.DATABASE_URL, adminUrl]);
    console.log("Service role bootstrapped.");
  }

  // 3. RLS policies, idempotent, also as the admin role (policy ownership
  // follows table ownership, not the connecting role).
  const rlsSql = readFileSync(join(__dirname, "..", "rls.sql"), "utf-8");
  await adminClient.unsafe(rlsSql);
  console.log("RLS policies applied.");

  await adminClient.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
