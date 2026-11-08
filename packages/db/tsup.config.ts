import { defineConfig } from "tsup";

/**
 * Builds the migration runner (src/migrate.ts) into one self-contained
 * dist/migrate.js for infra/Dockerfile.migrate — same "bundle everything"
 * approach as apps/collab's tsup config. The runtime image then ships no
 * node_modules at all: no tsx, so no esbuild binary (a Go program Trivy
 * flags for its old Go stdlib), only Node plus this file. The migration SQL
 * itself (../drizzle, ../rls.sql) is still read from disk at run time,
 * resolved relative to dist/ exactly as it is relative to src/.
 */
export default defineConfig({
  entry: ["src/migrate.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  noExternal: [/./],
  // Bundled CommonJS dependencies may call require() for Node built-ins;
  // ESM output has no require of its own.
  banner: { js: "import { createRequire as __kompastCreateRequire } from 'node:module'; const require = __kompastCreateRequire(import.meta.url);" },
});
