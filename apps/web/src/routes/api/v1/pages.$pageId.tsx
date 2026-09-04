import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { eq, schema } from "@kompast/db";
import { updatePageMeta, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolvePage } from "@/lib/api-resolvers";
import { createServerSchema } from "@/lib/blocknote-schema";

const updatePageSchema = z.object({
  title: z.string().min(1).optional(),
  icon: z.string().nullable().optional(),
});

export const Route = createFileRoute("/api/v1/pages/$pageId")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:read", "api");

          return withAuthorizedTenant(ctx, async (tx) => {
            const page = await resolvePage(tx, ctx, params.pageId, "view");
            const [state] = await tx.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, page.id));
            let content = "";
            if (state) {
              const ydoc = new Y.Doc();
              Y.applyUpdate(ydoc, state.state);
              const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
              const blocks = editor.yDocToBlocks(ydoc, "document-store");
              content = await editor.blocksToMarkdownLossy(blocks);
            }

            return jsonResponse({
              id: page.id,
              title: page.title,
              icon: page.icon,
              parentPageId: page.parentPageId,
              projectId: page.projectId,
              type: page.type,
              content,
              createdAt: page.createdAt.toISOString(),
              updatedAt: page.updatedAt.toISOString(),
            });
          });
        }),

      PATCH: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:write", "api");
          const body = updatePageSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            await resolvePage(tx, ctx, params.pageId, "edit");
            await updatePageMeta(tx, params.pageId, { title: body.title, icon: body.icon });
            return jsonResponse({ ok: true });
          });
        }),
    },
  },
});
