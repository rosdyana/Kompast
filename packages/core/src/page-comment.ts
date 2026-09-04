import { and, asc, eq, isNull, schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export interface AddPageCommentInput {
  pageId: string;
  blockId: string;
  authorId: string;
  bodyJson: Json;
}

export async function addPageComment(tx: Tx, input: AddPageCommentInput) {
  const commentId = id("pagecomment");
  await tx.insert(schema.pageComment).values({
    id: commentId,
    pageId: input.pageId,
    blockId: input.blockId,
    authorId: input.authorId,
    bodyJson: input.bodyJson,
  });
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
