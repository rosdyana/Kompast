import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node22",
  outDir: "dist",
  clean: true,
  // See apps/collab/tsup.config.ts for the full story: workspace packages
  // (@kompast/env here) are pnpm symlinks that don't resolve inside
  // Dockerfile.worker's runtime stage (dist/ + package.json + node_modules,
  // no packages/*) — confirmed with a real `docker run`, not assumed.
  // CJS, not ESM: ioredis (and its own node-abort-controller dependency)
  // do computed `require(...)` calls and deep extensionless subpath
  // requires (`require("ioredis/built/utils")`) that are both fine under
  // Node's native CJS resolution but break two different ways when
  // bundled/emitted as ESM — confirmed via a real `node dist/index.js`
  // run, not assumed: first "Dynamic require of ... is not supported"
  // (esbuild can't statically resolve a computed require into an ESM
  // import), then, after excluding those two packages from the bundle,
  // ERR_UNSUPPORTED_DIR_IMPORT (Node's ESM loader — unlike its CJS
  // loader — refuses to resolve a directory/extensionless import even
  // when left as a plain external specifier). CJS output sidesteps both:
  // it can bundle everything (noExternal: [/./]) with no per-package
  // carve-outs, and package.json's "type": "module" doesn't apply to a
  // .cjs file regardless.
  noExternal: [/./],
});
