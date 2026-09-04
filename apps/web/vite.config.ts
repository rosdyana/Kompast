import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  // Nitro's node-server preset is what self-hosts on the Debian box: it
  // builds a single `node .output/server/index.mjs` entry with no platform
  // adapter (Vercel/Netlify/Cloudflare), matching infra/Dockerfile.web.
  //
  // jsdom (a dep of @blocknote/server-util, used for markdown/Yjs
  // conversion in the pages REST + MCP routes) must stay external: one
  // of its internal CJS modules loads its own bundled default
  // stylesheet via `readFileSync(path.resolve(__dirname, ...))`. If
  // Rollup inlines it into a relocated chunk, `__dirname` doesn't exist
  // in ESM output at all, and even if it did the relative path would no
  // longer point at the real file — every request 500s (confirmed via a
  // real `docker build`+`docker run`, not just `pnpm build`). Marking it
  // external here only stops the bundling; jsdom is ALSO declared as a
  // direct dependency in package.json (it's normally only pulled in
  // transitively, and pnpm's strict isolation hides transitive-only
  // packages from a relocated chunk's plain `import "jsdom"`), and
  // infra/Dockerfile.web runs `pnpm deploy` to produce a real,
  // non-symlinked node_modules for the runtime image — Nitro itself does
  // NOT auto-copy externalized packages' files for the node-server
  // preset, so without both of those this "fix" just trades one crash
  // (ReferenceError: __dirname) for another (Cannot find module 'jsdom').
  nitro: {
    preset: "node-server",
    rollupConfig: {
      external: ["jsdom"],
    },
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact(), nitro()],
});
