import { createFileRoute } from "@tanstack/react-router";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyLocalStorageToken, resolveLocalPath, ensureLocalDir } from "@kompast/storage";

export const Route = createFileRoute("/api/storage/upload/$")({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        const key = params._splat ?? "";
        const url = new URL(request.url);
        const expires = Number(url.searchParams.get("expires"));
        const signature = url.searchParams.get("signature") ?? "";

        if (!key || !verifyLocalStorageToken({ action: "upload", key, expires, signature })) {
          return new Response("Invalid or expired upload URL", { status: 403 });
        }
        if (!request.body) return new Response("Missing body", { status: 400 });

        const path = resolveLocalPath(key);
        await ensureLocalDir(path);
        await pipeline(Readable.fromWeb(request.body as never), createWriteStream(path));

        return new Response(null, { status: 200 });
      },
    },
  },
});
