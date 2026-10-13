import { createFileRoute } from "@tanstack/react-router";
import { canAccessPage, withAuthorizedTenant } from "@kompast/core";
import { getStorageDriver } from "@kompast/storage";
import { ApiError, requireApiOrSessionAuth } from "@/lib/api-auth";
import { handleApiRoute } from "@/lib/api-response";

/**
 * Files stored with a page (today: images and attachments brought in by
 * the Notion importer, see lib/notion-import.ts). The URL in the doc is
 * this stable route, not a storage URL, so access is checked on every
 * view: whoever can see the page gets a short-lived storage URL, anyone
 * else gets the same 404 as for a page that doesn't exist.
 */
export const Route = createFileRoute("/api/page-assets/$pageId/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const name = params._splat ?? "";
          if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) throw new ApiError(404, "Not Found", "No such file");
          const ctx = await requireApiOrSessionAuth(request, "pages:read");
          const visible = await withAuthorizedTenant(ctx, (tx) => canAccessPage(tx, params.pageId, ctx, "view"));
          if (!visible) throw new ApiError(404, "Not Found", "No such file");

          const url = await getStorageDriver().getDownloadUrl(`page-assets/${params.pageId}/${name}`);
          return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
        }),
    },
  },
});
