import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { and, eq, schema } from "@kompast/db";
import { addCommentReaction, removeCommentReaction, withAuthorizedTenant, type Tx } from "@kompast/core";
import { ApiError, requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveIssue } from "@/lib/api-resolvers";

const addReactionSchema = z.object({ emoji: z.string().min(1) });
const removeReactionQuerySchema = z.object({ emoji: z.string().min(1) });

export const Route = createFileRoute("/api/v1/issues/$issueKey/comments/$commentId/reactions")({
  server: {
    handlers: {
      /** Adds the caller's reaction: 201 when it's new, 200 when it was already there. */
      POST: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = addReactionSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            const { issue } = await resolveIssue(tx, ctx.organizationId, params.issueKey);
            await assertCommentOnIssue(tx, params.commentId, issue.id);
            const { added } = await addCommentReaction(tx, {
              organizationId: ctx.organizationId,
              commentId: params.commentId,
              userId: ctx.userId,
              emoji: body.emoji,
              origin: ctx.origin,
              originClient: request.headers.get("user-agent") ?? undefined,
            });
            return jsonResponse({ commentId: params.commentId, emoji: body.emoji.trim(), added }, added ? 201 : 200);
          });
        }),

      /** Removes the caller's own reaction, given as ?emoji=. 204 whether or not it was there. */
      DELETE: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const query = removeReactionQuerySchema.parse({ emoji: new URL(request.url).searchParams.get("emoji") ?? undefined });

          return withAuthorizedTenant(ctx, async (tx) => {
            const { issue } = await resolveIssue(tx, ctx.organizationId, params.issueKey);
            await assertCommentOnIssue(tx, params.commentId, issue.id);
            await removeCommentReaction(tx, { commentId: params.commentId, userId: ctx.userId, emoji: query.emoji });
            return new Response(null, { status: 204 });
          });
        }),
    },
  },
});

/** The reaction routes address a comment by id under an issue key, so the comment must actually belong to that issue. */
async function assertCommentOnIssue(tx: Tx, commentId: string, issueId: string) {
  const [row] = await tx
    .select({ id: schema.issueComment.id })
    .from(schema.issueComment)
    .where(and(eq(schema.issueComment.id, commentId), eq(schema.issueComment.issueId, issueId)));
  if (!row) throw new ApiError(404, "Not Found", `Comment ${commentId} not found on this issue`);
}
