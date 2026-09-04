import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors vite.config.ts's `resolve: { tsconfigPaths: true }` — vitest
  // uses this standalone config, not the app's own, so the "@/*" -> "./src/*"
  // alias from tsconfig.json needs restating here explicitly.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    testTimeout: 15000,
  },
});
