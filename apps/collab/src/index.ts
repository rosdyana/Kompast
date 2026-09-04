import { loadEnv } from "@kompast/env";
import { createCollabServer } from "./server";

const env = loadEnv();

createCollabServer(env.COLLAB_INTERNAL_PORT).listen();

console.log(`[collab] Hocuspocus listening on :${env.COLLAB_INTERNAL_PORT}`);

process.on("SIGTERM", () => process.exit(0));
