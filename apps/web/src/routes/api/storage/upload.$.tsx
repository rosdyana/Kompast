import { createFileRoute } from "@tanstack/react-router";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyLocalStorageToken, resolveLocalPath, ensureLocalDir, MAX_UPLOAD_BYTES } from "@kompast/storage";

class UploadTooLargeError extends Error {}

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
        if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) {
          return new Response("File is too large", { status: 413 });
        }
        if (!request.body) return new Response("Missing body", { status: 400 });

        const path = resolveLocalPath(key);
        await ensureLocalDir(path);
        // Content-Length can be absent or lie (chunked uploads), so count the bytes as they stream.
        let received = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received > MAX_UPLOAD_BYTES) callback(new UploadTooLargeError());
            else callback(null, chunk);
          },
        });
        try {
          await pipeline(Readable.fromWeb(request.body as never), counter, createWriteStream(path));
        } catch (err) {
          await rm(path, { force: true });
          if (err instanceof UploadTooLargeError) return new Response("File is too large", { status: 413 });
          throw err;
        }

        return new Response(null, { status: 200 });
      },
    },
  },
});
