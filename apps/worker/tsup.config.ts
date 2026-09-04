import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  // See apps/collab/tsup.config.ts for the full story: workspace packages
  // (@kompast/env here) are pnpm symlinks that don't resolve inside
  // Dockerfile.worker's runtime stage (dist/ + package.json + node_modules,
  // no packages/*) — confirmed with a real `docker run`, not assumed.
  noExternal: [/./],
});
