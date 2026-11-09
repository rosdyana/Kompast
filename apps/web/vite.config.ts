import { defineConfig, type Plugin } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Dev only. Nitro's dev middleware treats a GET whose path ends in an asset
 * extension (.png, .jpg, ...) and whose request is an image fetch as a static
 * file, and hands it to Vite's static server instead of the app. Vite has no such
 * file, so the page-asset URLs (/api/page-assets/<pageId>/<name>.png) die as a bare
 * "Cannot GET" 404. The production Nitro build serves them. Marking these
 * requests as document fetches sends them down the path the app's routes already
 * get for extensions like .txt. The stored URL format is unchanged.
 */
function pageAssetsDevRoute(): Plugin {
  return {
    name: "kompast:page-assets-dev-route",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        // /api/storage/ too: the local storage driver's signed download URL (what
        // /api/page-assets redirects to in dev) also ends in the file's extension.
        if (req.url?.startsWith("/api/page-assets/") || req.url?.startsWith("/api/storage/")) req.headers["sec-fetch-dest"] = "document";
        next();
      });
    },
  };
}

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
  plugins: [pageAssetsDevRoute(), tailwindcss(), tanstackStart(), viteReact(), nitro()],
});
