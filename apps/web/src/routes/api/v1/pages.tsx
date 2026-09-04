import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import { and, eq, isNull, schema } from "@kompast/db";
import { createPage, filterAccessiblePages, listPageTree, withAuthorizedTenant, withIdempotency } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveProject } from "@/lib/api-resolvers";
import { createServerSchema } from "@/lib/blocknote-schema";

function serializePage(page: typeof schema.page.$inferSelect) {
  return {
    id: page.id,
    title: page.title,
    icon: page.icon,
    parentPageId: page.parentPageId,
    projectId: page.projectId,
    type: page.type,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
  };
}

const createPageSchema = z.object({
  title: z.string().min(1),
  parentPageId: z.string().nullable().optional(),
  projectKey: z.string().optional(),
  content: z.string().optional(),
});

export const Route = createFileRoute("/api/v1/pages")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:read", "api");
          const url = new URL(request.url);
          const projectKey = url.searchParams.get("projectKey");

          return withAuthorizedTenant(ctx, async (tx) => {
            const projectId = projectKey ? (await resolveProject(tx, ctx.organizationId, projectKey)).id : null;
            const pages =
              projectKey !== null
                ? await tx
                    .select()
                    .from(schema.page)
                    .where(and(eq(schema.page.organizationId, ctx.organizationId), isNull(schema.page.archivedAt), eq(schema.page.projectId, projectId!)))
                : await listPageTree(tx, ctx.organizationId, null);
            const visible = await filterAccessiblePages(tx, pages, ctx);
            return jsonResponse({ data: visible.map(serializePage) });
          });
        }),

      POST: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:write", "api");
          const body = createPageSchema.parse(await request.json());
          const idempotencyKey = request.headers.get("idempotency-key");

          return withAuthorizedTenant(ctx, async (tx) => {
            const run = async () => {
              const projectId = body.projectKey ? (await resolveProject(tx, ctx.organizationId, body.projectKey)).id : null;
              const page = await createPage(tx, {
                organizationId: ctx.organizationId,
                title: body.title,
                parentPageId: body.parentPageId,
                projectId,
                actorUserId: ctx.userId,
              });

              // Safe to write ydoc_state directly ONLY because this page was
              // just created — no live collab connection can possibly exist
              // for an id that didn't exist a moment ago, so there's nothing
              // to race with. This is NOT a pattern for updating an existing
              // page's content (see PATCH, deliberately not implemented for
              // that reason — see api-resolvers.ts / plan notes).
              if (body.content) {
                const editor = ServerBlockNoteEditor.create({ schema: createServerSchema() as any });
                const blocks = await editor.tryParseMarkdownToBlocks(body.content);
                const ydoc = editor.blocksToYDoc(blocks, "document-store");
                await tx.insert(schema.ydocState).values({ pageId: page.id, state: Buffer.from(Y.encodeStateAsUpdate(ydoc)) });
              }

              return serializePage(page);
            };

            if (!idempotencyKey) return jsonResponse(await run(), 201);
            const { replayed, response } = await withIdempotency(tx, ctx.organizationId, "create_page", idempotencyKey, run);
            return jsonResponse(response, replayed ? 200 : 201);
          });
        }),
    },
  },
});
