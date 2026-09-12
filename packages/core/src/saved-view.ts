import { asc, eq, schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

/**
 * The config shape itself lives in ./table-view-config.ts, which has no
 * @kompast/db import — client components reach it via the
 * "@kompast/core/table-view-config" subpath export (see that file's own
 * doc comment) so they never pull this file's Postgres client into the
 * browser bundle. Re-exported here for every existing server-side caller
 * that already imports from the "@kompast/core" barrel.
 */
export * from "./table-view-config";
import { DEFAULT_TABLE_VIEW_CONFIG, type TableViewConfig } from "./table-view-config";

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
