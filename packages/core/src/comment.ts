import { asc, eq, inArray, schema, type Json } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import type { Tx } from "./types";
import { id } from "./ids";
import { notify } from "./notification";

export interface AddCommentInput {
  issueId: string;
  authorId: string;
  bodyJson: Json;
  origin?: "user" | "automation" | "mcp" | "api" | "import";
  originClient?: string;
}

/**
 * Notifies the issue's assignee and reporter (never the commenter about
 * their own comment, and never the same person twice if they're both).
 * Best-effort: a missing project/user row here would be a data-integrity
 * bug elsewhere, not something a comment should fail over, so this reads
 * what it needs directly rather than requiring the caller to already have
 * it (addComment is called from REST/MCP/UI alike, not all of which have
 * project key/title in hand).
 */
async function notifyCommentParticipants(tx: Tx, issueId: string, authorId: string) {
  const [row] = await tx
    .select({
      organizationId: schema.issue.organizationId,
      title: schema.issue.title,
      keySeq: schema.issue.keySeq,
      assigneeId: schema.issue.assigneeId,
      reporterId: schema.issue.reporterId,
      projectKey: schema.project.key,
    })
    .from(schema.issue)
    .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
    .where(eq(schema.issue.id, issueId));
  if (!row) return;

  const recipients = [...new Set([row.assigneeId, row.reporterId].filter((userId): userId is string => !!userId && userId !== authorId))];
  if (recipients.length === 0) return;

  const users = await tx.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(inArray(schema.user.id, recipients));
  const emailByUserId = new Map(users.map((u) => [u.id, u.email]));

  const issueKey = `${row.projectKey}-${row.keySeq}`;
  const actionUrl = `${loadEnv().APP_URL}/issues/${row.projectKey}/${row.keySeq}`;
  for (const userId of recipients) {
    const email = emailByUserId.get(userId);
    await notify(tx, {
      organizationId: row.organizationId,
      userId,
      eventType: "issue.commented",
      entityType: "issue",
      entityId: issueId,
      title: `Komentar baru di ${issueKey}`,
      body: row.title,
      email: email ? { to: email, actionUrl, actionLabel: "Lihat tiket" } : undefined,
    });
  }
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
  await notifyCommentParticipants(tx, input.issueId, input.authorId);
  return { commentId };
}

export async function listComments(tx: Tx, issueId: string) {
  return tx
    .select()
    .from(schema.issueComment)
    .where(eq(schema.issueComment.issueId, issueId))
    .orderBy(asc(schema.issueComment.createdAt));
}
