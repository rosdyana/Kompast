import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { addPageComment, listPageComments, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolvePage } from "@/lib/api-resolvers";

const addCommentSchema = z.object({ text: z.string().min(1), blockId: z.string().optional() });

export const Route = createFileRoute("/api/v1/pages/$pageId/comments")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            await resolvePage(tx, ctx, params.pageId, "view");
            const comments = await listPageComments(tx, params.pageId);
            return jsonResponse({
              data: comments.map((c) => ({
                id: c.id,
                authorId: c.authorId,
                text: (c.bodyJson as { text?: string } | null)?.text ?? "",
                createdAt: c.createdAt.toISOString(),
              })),
            });
          });
        }),

      POST: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "pages:write", "api");
          const body = addCommentSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            await resolvePage(tx, ctx, params.pageId, "comment");
            const result = await addPageComment(tx, {
              pageId: params.pageId,
              blockId: body.blockId ?? "page",
              authorId: ctx.userId,
              bodyJson: { text: body.text },
            });
            return jsonResponse({ id: result.commentId }, 201);
          });
        }),
    },
  },
});
