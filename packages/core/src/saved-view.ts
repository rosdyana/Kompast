import { asc, eq, schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export interface TableViewConfig {
  groupBy: "column" | "assignee" | "none";
  sortBy: "rank" | "priority" | "dueDate" | "points" | "key";
  sortDir: "asc" | "desc";
}

export const DEFAULT_TABLE_VIEW_CONFIG: TableViewConfig = {
  groupBy: "column",
  sortBy: "rank",
  sortDir: "asc",
};

export async function listSavedViews(tx: Tx, boardId: string) {
  return tx.select().from(schema.savedView).where(eq(schema.savedView.boardId, boardId)).orderBy(asc(schema.savedView.name));
}

/**
 * The project page needs exactly one table view to exist per board so
 * clicking "Tabel" always has somewhere to persist grouping/sorting —
 * rather than surface an empty "create your first view" step for a
 * feature meant to be a one-click alternate rendering of the same board.
 */
export async function getOrCreateDefaultTableView(tx: Tx, boardId: string, createdBy: string) {
  const [existing] = await tx
    .select()
    .from(schema.savedView)
    .where(eq(schema.savedView.boardId, boardId))
    .limit(1);
  if (existing) return existing;

  const viewId = id("view");
  await tx.insert(schema.savedView).values({
    id: viewId,
    boardId,
    name: "Tabel",
    mode: "table",
    config: DEFAULT_TABLE_VIEW_CONFIG as unknown as Json,
    createdBy,
  });
  const [created] = await tx.select().from(schema.savedView).where(eq(schema.savedView.id, viewId));
  return created!;
}

export async function updateSavedViewConfig(tx: Tx, viewId: string, config: TableViewConfig) {
  await tx.update(schema.savedView).set({ config: config as unknown as Json }).where(eq(schema.savedView.id, viewId));
}
