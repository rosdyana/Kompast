import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { createImportRun, markImportRunRunning, completeImportRun, failImportRun, requirePageImportTarget, withAuthorizedTenant } from "@kompast/core";
import { readNotionExport, runNotionImport, MAX_NOTION_PAGES, type NotionExport } from "@kompast/import";
import { ApiError, requireApiOrSessionAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { createNotionPageConverter } from "@/lib/notion-import";

/** Notion splits workspace exports into parts well under this; upload them one at a time. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

const fieldsSchema = z.object({
  target: z.enum(["workspace", "private"]),
  dryRun: z.enum(["true", "false"]).optional(),
});

/**
 * Imports a Notion export zip (Markdown & CSV or HTML, from a page's
 * "Export" or Settings → Export all workspace content) into the Workspace
 * docs (workspace admins only) or the caller's own Private space.
 *
 * multipart/form-data, not JSON: `file` (the zip), `target`, optional
 * `dryRun`. The app's own import dialog calls this too, with its session
 * cookie, since server functions don't carry file uploads well.
 *
 * Synchronous, like the JIRA import: the zip is parsed outside any
 * transaction, then everything is loaded in one. A very large export can
 * outlast a reverse proxy's timeout, which is why the page count is capped.
 */
export const Route = createFileRoute("/api/v1/imports/notion")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiOrSessionAuth(request, "pages:write");
          if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES) {
            throw new ApiError(413, "Payload Too Large", "The export is over 200 MB. Export fewer pages at a time, or upload each Part zip separately.");
          }
          const form = await request.formData().catch(() => {
            throw new ApiError(400, "Bad Request", "Expected multipart/form-data with a `file` field");
          });
          const file = form.get("file");
          if (!(file instanceof File)) throw new ApiError(400, "Bad Request", "Missing `file` (the Notion export .zip)");
          if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "Payload Too Large", "The export is over 200 MB.");
          const fields = fieldsSchema.safeParse({ target: form.get("target"), dryRun: form.get("dryRun") ?? undefined });
          if (!fields.success) throw new ApiError(400, "Bad Request", "`target` must be \"workspace\" or \"private\"");
          const { target } = fields.data;
          const dryRun = fields.data.dryRun === "true";

          const { importRunId } = await withAuthorizedTenant(ctx, async (tx) => {
            await requirePageImportTarget(tx, ctx, target);
            const run = await createImportRun(tx, {
              organizationId: ctx.organizationId,
              projectId: null,
              source: "notion",
              dryRun,
              config: { target, fileName: file.name },
              createdBy: ctx.userId,
            });
            await markImportRunRunning(tx, run.importRunId);
            return run;
          });

          let exp: NotionExport;
          try {
            exp = readNotionExport(new Uint8Array(await file.arrayBuffer()));
            if (exp.pages.length === 0) throw new Error("No Notion pages found. Export as \"HTML\" or \"Markdown & CSV\" and upload the .zip as downloaded.");
            if (exp.pages.length > MAX_NOTION_PAGES) {
              throw new Error(`The export has ${exp.pages.length} pages; the limit is ${MAX_NOTION_PAGES} per import. Export a smaller part of the workspace.`);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await withAuthorizedTenant(ctx, (tx) => failImportRun(tx, importRunId, message));
            return jsonResponse({ importRunId, error: message }, 422);
          }

          try {
            const report = await withAuthorizedTenant(ctx, async (tx) => {
              const report = await runNotionImport(tx, exp, {
                organizationId: ctx.organizationId,
                actorUserId: ctx.userId,
                importRunId,
                target,
                dryRun,
                convertPage: createNotionPageConverter(exp),
              });
              await completeImportRun(tx, importRunId, report.counts, report.errors);
              return report;
            });
            return jsonResponse({ importRunId, report }, dryRun ? 200 : 201);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await withAuthorizedTenant(ctx, (tx) => failImportRun(tx, importRunId, message));
            return jsonResponse({ importRunId, error: message }, 500);
          }
        }),
    },
  },
});
