import { loadEnv } from "@kompast/env";

/**
 * Placeholder Hocuspocus process — wired up in P2 (Docs core) alongside
 * BlockNote collaboration. Kept as a real, runnable service now so
 * docker-compose and CI build against a stable shape from P0 onward
 * instead of being retrofitted later. See plan §Architecture.
 */
const env = loadEnv();

console.log(`[collab] placeholder listening on :${env.COLLAB_INTERNAL_PORT} (Hocuspocus lands in P2)`);

process.on("SIGTERM", () => process.exit(0));
