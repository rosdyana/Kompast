import { and, eq, max, sql } from "drizzle-orm";
import { schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { rankBetween } from "./rank";

export interface CreateIssueInput {
  organizationId: string;
  projectId: string;
  typeId: string;
  statusId: string;
  title: string;
  reporterId: string;
  assigneeId?: string;
  priority?: "lowest" | "low" | "medium" | "high" | "highest";
  descriptionJson?: unknown;
}

/**
 * Assigns the next per-project issue key (KPT-123) and inserts the issue.
 * Locks the project row first so concurrent creates in the same project
 * serialize on key assignment instead of racing — the alternative (a bare
 * `max(key_seq)+1` with no lock) can hand two concurrent inserts the same
 * key, which the unique index would then reject for one of them anyway,
 * just later and less clearly.
 */
export async function createIssue(tx: Tx, input: CreateIssueInput) {
  await tx.execute(sql`select id from project where id = ${input.projectId} for update`);

  // A bare aggregate with no GROUP BY always returns exactly one row, even
  // over zero matching issues (nextSeq is then coalesce(null,0)+1 = 1).
  const [seqRow] = await tx
    .select({ nextSeq: sql<number>`coalesce(${max(schema.issue.keySeq)}, 0) + 1` })
    .from(schema.issue)
    .where(eq(schema.issue.projectId, input.projectId));
  const nextSeq = seqRow!.nextSeq;

  const [lastCard] = await tx
    .select({ rank: schema.issue.rank })
    .from(schema.issue)
    .where(and(eq(schema.issue.projectId, input.projectId), eq(schema.issue.statusId, input.statusId)))
    .orderBy(sql`${schema.issue.rank} desc`)
    .limit(1);

  const issueId = id("issue");
  await tx.insert(schema.issue).values({
    id: issueId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    keySeq: nextSeq,
    typeId: input.typeId,
    statusId: input.statusId,
    title: input.title,
    descriptionJson: input.descriptionJson,
    reporterId: input.reporterId,
    assigneeId: input.assigneeId,
    priority: input.priority ?? "medium",
    rank: rankBetween(lastCard?.rank ?? null, null),
  });

  await tx.insert(schema.issueHistory).values({
    id: id("hist"),
    issueId,
    actorId: input.reporterId,
    field: "created",
    toValue: input.title,
  });

  return { issueId, keySeq: nextSeq };
}

export interface MoveIssueInput {
  issueId: string;
  toStatusId: string;
  beforeIssueId?: string;
  afterIssueId?: string;
  actorId: string;
  origin?: "user" | "automation" | "mcp" | "api" | "import";
  originClient?: string;
}

/**
 * Moves a card: status change + rerank, both written in the same
 * transaction as the issue_history rows that make burndown/CFD/activity
 * feed possible. `beforeIssueId`/`afterIssueId` are the cards it's being
 * dropped between on the client — never trust a client-supplied literal
 * rank string, always recompute from real neighbor ranks server-side.
 */
export async function moveIssue(tx: Tx, input: MoveIssueInput) {
  const [current] = await tx
    .select({ statusId: schema.issue.statusId, rank: schema.issue.rank })
    .from(schema.issue)
    .where(eq(schema.issue.id, input.issueId))
    .limit(1);
  if (!current) throw new Error(`Issue ${input.issueId} not found`);

  const [beforeRow, afterRow] = await Promise.all([
    input.beforeIssueId
      ? tx.select({ rank: schema.issue.rank }).from(schema.issue).where(eq(schema.issue.id, input.beforeIssueId))
      : Promise.resolve([]),
    input.afterIssueId
      ? tx.select({ rank: schema.issue.rank }).from(schema.issue).where(eq(schema.issue.id, input.afterIssueId))
      : Promise.resolve([]),
  ]);

  const newRank = rankBetween(beforeRow[0]?.rank ?? null, afterRow[0]?.rank ?? null);

  await tx
    .update(schema.issue)
    .set({ statusId: input.toStatusId, rank: newRank, updatedAt: new Date() })
    .where(eq(schema.issue.id, input.issueId));

  if (current.statusId !== input.toStatusId) {
    await tx.insert(schema.issueHistory).values({
      id: id("hist"),
      issueId: input.issueId,
      actorId: input.actorId,
      origin: input.origin ?? "user",
      originClient: input.originClient,
      field: "status",
      fromValue: current.statusId,
      toValue: input.toStatusId,
    });
  }
}
