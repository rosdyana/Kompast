import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv } from "@kompast/env";
import * as schema from "./schema";

const env = loadEnv();

const client = postgres(env.DATABASE_URL);

export const db = drizzle(client, { schema });
export * as schema from "./schema";
export { withTenant } from "./tenant";
