import { and, asc, eq, isNull, schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { extractMentionedUserIds } from "./rich-text";
import { notifyPageMentions } from "./page-mention";

export interface AddPageCommentInput {
  pageId: string;
  blockId: string;
  authorId: string;
  bodyJson: Json;
}

/**
 * Stores a doc comment and notifies anyone @mentioned in it. The notification
 * lives here, not in the server fn, so the UI, REST and MCP callers all get it.
 * Legacy `{ text }` bodies carry no mention nodes, so they skip the page lookup.
 */
export async function addPageComment(tx: Tx, input: AddPageCommentInput) {
  const commentId = id("pagecomment");
  await tx.insert(schema.pageComment).values({
    id: commentId,
    pageId: input.pageId,
    blockId: input.blockId,
    authorId: input.authorId,
    bodyJson: input.bodyJson,
  });

  const mentionedUserIds = extractMentionedUserIds(input.bodyJson);
  if (mentionedUserIds.length > 0) {
    const [page] = await tx.select({ organizationId: schema.page.organizationId }).from(schema.page).where(eq(schema.page.id, input.pageId));
    if (page) {
      await notifyPageMentions(tx, {
        organizationId: page.organizationId,
        pageId: input.pageId,
        actorId: input.authorId,
        userIds: mentionedUserIds,
        context: "comment",
      });
    }
  }

  return { commentId };
}

export async function listPageComments(tx: Tx, pageId: string) {
  return tx
    .select()
    .from(schema.pageComment)
    .where(and(eq(schema.pageComment.pageId, pageId), isNull(schema.pageComment.resolvedAt)))
    .orderBy(asc(schema.pageComment.createdAt));
}

export async function resolvePageComment(tx: Tx, commentId: string) {
  await tx.update(schema.pageComment).set({ resolvedAt: new Date() }).where(eq(schema.pageComment.id, commentId));
}
