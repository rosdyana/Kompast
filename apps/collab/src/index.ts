import { loadEnv } from "@kompast/env";
import { createCollabServer } from "./server";

const env = loadEnv();

// No SIGTERM handler here on purpose: Hocuspocus's listen() registers its own
// SIGINT/SIGTERM handler, which stores pending documents (destroy()) and then
// exits. A second handler calling process.exit(0) would cut that flush off
// and lose the last debounced edits on every deploy.
createCollabServer(env.COLLAB_INTERNAL_PORT)
  .listen()
  .then(() => console.log(`[collab] Hocuspocus listening on :${env.COLLAB_INTERNAL_PORT}`))
  .catch((err) => {
    console.error("[collab] failed to start:", err);
    process.exit(1);
  });
