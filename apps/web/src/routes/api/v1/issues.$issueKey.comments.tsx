import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { addComment, listComments, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveIssue } from "@/lib/api-resolvers";

const addCommentSchema = z.object({ text: z.string().min(1) });

export const Route = createFileRoute("/api/v1/issues/$issueKey/comments")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const { issue } = await resolveIssue(tx, ctx.organizationId, params.issueKey);
            const comments = await listComments(tx, issue.id);
            return jsonResponse({
              data: comments.map((c) => ({
                id: c.id,
                authorId: c.authorId,
                text: (c.bodyJson as { text?: string } | null)?.text ?? "",
                createdAt: c.createdAt,
              })),
            });
          });
        }),

      POST: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = addCommentSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            const { issue } = await resolveIssue(tx, ctx.organizationId, params.issueKey);
            const result = await addComment(tx, {
              issueId: issue.id,
              authorId: ctx.userId,
              bodyJson: { text: body.text },
              origin: ctx.origin,
              originClient: request.headers.get("user-agent") ?? undefined,
            });
            return jsonResponse({ id: result.commentId }, 201);
          });
        }),
    },
  },
});
