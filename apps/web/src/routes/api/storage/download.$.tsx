import { createFileRoute } from "@tanstack/react-router";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { verifyLocalStorageToken, resolveLocalPath } from "@kompast/storage";
import { db, schema, eq } from "@kompast/db";
import { contentTypeFor } from "@/lib/content-type";

/**
 * `filename=` is an ASCII fallback; `filename*` carries the real name. Putting a non-Latin-1 name
 * straight into the header throws, so the fallback replaces it.
 */
function contentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

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

        // Page assets (imported images) have no attachment row; their
        // type comes from the extension. Served from the app's own origin,
        // so an SVG could carry script: the sandbox CSP keeps it inert
        // when opened directly, and <img> rendering doesn't run it anyway.
        const fileName = attachment?.fileName ?? key.slice(key.lastIndexOf("/") + 1);
        const contentType = attachment?.contentType ?? contentTypeFor(fileName);
        // Only raster images and PDFs open inline. SVG can carry script, so it downloads like any other type.
        const mime = contentType.split(";")[0]!.trim().toLowerCase();
        const inline = (mime.startsWith("image/") && mime !== "image/svg+xml") || mime === "application/pdf";
        return new Response(Readable.toWeb(createReadStream(path)) as never, {
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": contentDisposition(fileName, inline),
            "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
