import { createFileRoute } from "@tanstack/react-router";
import { withAuthorizedTenant } from "@kompast/core";
import { schema, eq } from "@kompast/db";
import { getStorageDriver } from "@kompast/storage";
import { ApiError, requireApiOrSessionAuth } from "@/lib/api-auth";
import { handleApiRoute } from "@/lib/api-response";

/**
 * The stable URL of an issue attachment. Imported descriptions and comments
 * point here, not at a storage URL or at JIRA, so the link keeps working.
 * Access is checked on every view: RLS hides attachments of issues the caller
 * can't see, so those get the same 404 as an attachment that doesn't exist.
 * A stored file redirects to a short-lived storage URL. A file that isn't
 * stored here (a JIRA migration file not copied) redirects to its JIRA page.
 */
export const Route = createFileRoute("/api/issue-attachments/$attachmentId")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiOrSessionAuth(request, "issues:read");
          const row = await withAuthorizedTenant(ctx, async (tx) => {
            const [found] = await tx
              .select({ storageKey: schema.issueAttachment.storageKey, sourceUrl: schema.issueAttachment.sourceUrl })
              .from(schema.issueAttachment)
              .where(eq(schema.issueAttachment.id, params.attachmentId));
            return found ?? null;
          });
          if (!row) throw new ApiError(404, "Not Found", "No such attachment");

          const location = row.storageKey
            ? await getStorageDriver().getDownloadUrl(row.storageKey)
            : row.sourceUrl;
          if (!location) throw new ApiError(404, "Not Found", "No such attachment");
          return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "private, no-store" } });
        }),
    },
  },
});
