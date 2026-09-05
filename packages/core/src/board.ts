import { and, asc, eq, inArray, schema } from "@kompast/db";
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
            customFields: schema.issue.customFields,
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

/**
 * board/board_column/board_column_status have NO RLS (a pre-existing gap —
 * see packages/db/rls.sql, absent from its enable list). Every function
 * below does its own explicit ownership join (column -> board -> project)
 * before writing — not optional defense-in-depth, the only thing stopping
 * a caller who legitimately administers project A from mutating a column
 * belonging to project B by guessing/enumerating a columnId.
 */
async function requireColumnInProject(tx: Tx, columnId: string, projectId: string): Promise<void> {
  const [row] = await tx
    .select({ id: schema.boardColumn.id })
    .from(schema.boardColumn)
    .innerJoin(schema.board, eq(schema.board.id, schema.boardColumn.boardId))
    .where(and(eq(schema.boardColumn.id, columnId), eq(schema.board.projectId, projectId)))
    .limit(1);
  if (!row) throw new Error(`Column ${columnId} not found in project ${projectId}`);
}

export interface UpdateBoardColumnInput {
  projectId: string;
  columnId: string;
  name?: string;
  color?: string;
  /** undefined = leave unchanged; null = clear to unlimited ("∞" in the UI) */
  wipLimit?: number | null;
}

export async function updateBoardColumn(tx: Tx, input: UpdateBoardColumnInput): Promise<void> {
  await requireColumnInProject(tx, input.columnId, input.projectId);
  const set: Partial<{ name: string; color: string; wipLimit: number | null }> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.color !== undefined) set.color = input.color;
  if (input.wipLimit !== undefined) set.wipLimit = input.wipLimit;
  if (Object.keys(set).length === 0) return;
  await tx.update(schema.boardColumn).set(set).where(eq(schema.boardColumn.id, input.columnId));
}

export interface DeleteBoardColumnInput {
  projectId: string;
  columnId: string;
}

/**
 * Never touches an issue row (matches this file's own getBoard comment:
 * "reordering or renaming a column never touches an issue row"). "Tickets
 * return to Backlog" is implemented by repointing board_column_status rows
 * from the doomed column to the board's Backlog column — one UPDATE,
 * independent of ticket count, leaving issue.statusId/history/burndown
 * completely untouched.
 */
export async function deleteBoardColumn(tx: Tx, input: DeleteBoardColumnInput): Promise<void> {
  const [column] = await tx
    .select({ id: schema.boardColumn.id, boardId: schema.boardColumn.boardId, isBacklog: schema.boardColumn.isBacklog })
    .from(schema.boardColumn)
    .innerJoin(schema.board, eq(schema.board.id, schema.boardColumn.boardId))
    .where(and(eq(schema.boardColumn.id, input.columnId), eq(schema.board.projectId, input.projectId)))
    .limit(1);
  if (!column) throw new Error(`Column ${input.columnId} not found in project ${input.projectId}`);
  if (column.isBacklog) throw new Error("The Backlog column cannot be deleted");

  const [backlog] = await tx
    .select({ id: schema.boardColumn.id })
    .from(schema.boardColumn)
    .where(and(eq(schema.boardColumn.boardId, column.boardId), eq(schema.boardColumn.isBacklog, true)))
    .limit(1);
  if (!backlog) throw new Error(`Board ${column.boardId} has no Backlog column`);

  await tx
    .update(schema.boardColumnStatus)
    .set({ boardColumnId: backlog.id })
    .where(eq(schema.boardColumnStatus.boardColumnId, input.columnId));
  await tx.delete(schema.boardColumn).where(eq(schema.boardColumn.id, input.columnId));
}

export interface ReorderBoardColumnsInput {
  projectId: string;
  boardId: string;
  /** Full new order for every column on this board; must include exactly the board's current column-id set. */
  orderedColumnIds: string[];
}

export async function reorderBoardColumns(tx: Tx, input: ReorderBoardColumnsInput): Promise<void> {
  const [board] = await tx
    .select({ id: schema.board.id })
    .from(schema.board)
    .where(and(eq(schema.board.id, input.boardId), eq(schema.board.projectId, input.projectId)))
    .limit(1);
  if (!board) throw new Error(`Board ${input.boardId} not found in project ${input.projectId}`);

  const columns = await tx
    .select({ id: schema.boardColumn.id, isBacklog: schema.boardColumn.isBacklog })
    .from(schema.boardColumn)
    .where(eq(schema.boardColumn.boardId, input.boardId));

  const currentIds = new Set(columns.map((c) => c.id));
  const requestedIds = new Set(input.orderedColumnIds);
  if (currentIds.size !== requestedIds.size || [...currentIds].some((id) => !requestedIds.has(id))) {
    throw new Error("orderedColumnIds must include exactly the board's current columns, no more and no less");
  }

  const backlogId = columns.find((c) => c.isBacklog)?.id;
  if (backlogId && input.orderedColumnIds[0] !== backlogId) {
    throw new Error("The Backlog column must stay first");
  }

  for (const [index, columnId] of input.orderedColumnIds.entries()) {
    await tx.update(schema.boardColumn).set({ order: index }).where(eq(schema.boardColumn.id, columnId));
  }
}
