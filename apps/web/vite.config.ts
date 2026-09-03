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
  nitro: {
    preset: "node-server",
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact(), nitro()],
});
