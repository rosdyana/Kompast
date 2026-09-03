import { asc, eq, inArray } from "drizzle-orm";
import { schema } from "@kompast/db";
import type { Tx } from "./types";

/**
 * Board data shaped for the kanban UI: columns in display order, each with
 * its issues in rank order. One query per table, joined in memory — the
 * board itself is small (columns: tens, issues: hundreds) so this reads
 * far more clearly than one deep SQL join and is cheap enough not to matter.
 */
export async function getBoard(tx: Tx, boardId: string) {
  const columns = await tx
    .select()
    .from(schema.boardColumn)
    .where(eq(schema.boardColumn.boardId, boardId))
    .orderBy(asc(schema.boardColumn.order));

  if (columns.length === 0) return { columns: [] };

  const columnStatuses = await tx
    .select()
    .from(schema.boardColumnStatus)
    .where(
      inArray(
        schema.boardColumnStatus.boardColumnId,
        columns.map((c) => c.id),
      ),
    );

  const statusIds = columnStatuses.map((cs) => cs.workflowStatusId);
  const statusToColumn = new Map(columnStatuses.map((cs) => [cs.workflowStatusId, cs.boardColumnId]));

  const issues =
    statusIds.length > 0
      ? await tx
          .select({
            id: schema.issue.id,
            keySeq: schema.issue.keySeq,
            projectId: schema.issue.projectId,
            statusId: schema.issue.statusId,
            typeId: schema.issue.typeId,
            title: schema.issue.title,
            assigneeId: schema.issue.assigneeId,
            priority: schema.issue.priority,
            storyPoints: schema.issue.storyPoints,
            dueDate: schema.issue.dueDate,
            rank: schema.issue.rank,
            labels: schema.issue.labels,
          })
          .from(schema.issue)
          .where(inArray(schema.issue.statusId, statusIds))
          .orderBy(asc(schema.issue.rank))
      : [];

  const issuesByColumn = new Map<string, typeof issues>();
  for (const issue of issues) {
    const columnId = statusToColumn.get(issue.statusId);
    if (!columnId) continue;
    const bucket = issuesByColumn.get(columnId) ?? [];
    bucket.push(issue);
    issuesByColumn.set(columnId, bucket);
  }

  return {
    columns: columns.map((col) => ({
      ...col,
      statusIds: columnStatuses.filter((cs) => cs.boardColumnId === col.id).map((cs) => cs.workflowStatusId),
      issues: issuesByColumn.get(col.id) ?? [],
    })),
  };
}
