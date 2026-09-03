import { createFileRoute } from "@tanstack/react-router";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { verifyLocalStorageToken, resolveLocalPath } from "@kompast/storage";
import { db, schema, eq } from "@kompast/db";

export const Route = createFileRoute("/api/storage/download/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const key = params._splat ?? "";
        const url = new URL(request.url);
        const expires = Number(url.searchParams.get("expires"));
        const signature = url.searchParams.get("signature") ?? "";

        if (!key || !verifyLocalStorageToken({ action: "download", key, expires, signature })) {
          return new Response("Invalid or expired download URL", { status: 403 });
        }

        const path = resolveLocalPath(key);
        if (!existsSync(path)) return new Response("Not found", { status: 404 });

        // The local driver's whole contract is "no DB access needed to
        // move bytes" — this lookup is the one deliberate exception,
        // purely to recover Content-Type/filename for the response
        // headers, since (unlike GCS) local files carry no object
        // metadata of their own. It never checks permissions: the caller
        // (packages/core's listAttachments) already re-verified access
        // before minting this URL, and the signature above is what
        // actually gates the request.
        const [attachment] = await db
          .select({ contentType: schema.issueAttachment.contentType, fileName: schema.issueAttachment.fileName })
          .from(schema.issueAttachment)
          .where(eq(schema.issueAttachment.storageKey, key));

        return new Response(Readable.toWeb(createReadStream(path)) as never, {
          headers: {
            "Content-Type": attachment?.contentType ?? "application/octet-stream",
            "Content-Disposition": `inline; filename="${attachment?.fileName ?? "download"}"`,
          },
        });
      },
    },
  },
});
