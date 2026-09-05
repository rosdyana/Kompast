import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv } from "@kompast/env";
import { bootstrapAppRole } from "./bootstrap-roles";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const env = loadEnv();

  // 1. Schema migrations, as the owning/admin role.
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
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
  await bootstrapAppRole(env.DATABASE_ADMIN_URL, env.DATABASE_URL);
  console.log("App role bootstrapped.");

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
