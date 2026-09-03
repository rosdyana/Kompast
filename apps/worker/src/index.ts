import { loadEnv } from "@kompast/env";

/**
 * Placeholder BullMQ worker process — real queues (email, automation, AI,
 * sprint cron, embeddings, exports) are added phase-by-phase (see plan
 * §Phases). Kept as a real, runnable service now so docker-compose and CI
 * build against a stable shape from P0 onward.
 */
const env = loadEnv();

console.log(`[worker] placeholder started, connected to redis at ${env.REDIS_URL}`);

process.on("SIGTERM", () => process.exit(0));
