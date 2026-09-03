import { asc, eq, schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export interface AddCommentInput {
  issueId: string;
  authorId: string;
  bodyJson: Json;
  origin?: "user" | "automation" | "mcp" | "api" | "import";
  originClient?: string;
}

export async function addComment(tx: Tx, input: AddCommentInput) {
  const commentId = id("comment");
  await tx.insert(schema.issueComment).values({
    id: commentId,
    issueId: input.issueId,
    authorId: input.authorId,
    bodyJson: input.bodyJson,
    origin: input.origin ?? "user",
    originClient: input.originClient,
  });
  return { commentId };
}

export async function listComments(tx: Tx, issueId: string) {
  return tx
    .select()
    .from(schema.issueComment)
    .where(eq(schema.issueComment.issueId, issueId))
    .orderBy(asc(schema.issueComment.createdAt));
}
