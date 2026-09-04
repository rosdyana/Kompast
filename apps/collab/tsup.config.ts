import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  // Bundle every dependency, workspace and npm alike, into a single dist/index.js
  // with nothing resolved from node_modules at runtime. Two real failures led
  // here, each confirmed with an actual `docker run` against Dockerfile.collab's
  // runtime stage (which copies dist/ + package.json + node_modules, nothing
  // else): first ERR_MODULE_NOT_FOUND for @kompast/env — its node_modules entry
  // is a pnpm symlink to ../../packages/env, which the runtime stage never
  // copies — then, after excluding only @kompast/* from externalization, the
  // same error for @hocuspocus/server, a real npm package whose symlink lives
  // in apps/collab's own nested node_modules, which the Dockerfile also never
  // copies (only the repo-root one). Bundling everything sidesteps the runtime
  // image's node_modules layout entirely, matching how apps/web's Nitro build
  // already ships .output/server as one self-contained tree.
  noExternal: [/./],
});
