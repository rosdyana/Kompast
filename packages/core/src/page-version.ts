import { and, desc, eq, schema } from "@kompast/db";
import type { Tx } from "./types";

/** Newest first — id/createdAt/authorId only; the snapshot bytes are fetched separately (see getPageVersionSnapshot). */
export async function listPageVersions(tx: Tx, pageId: string) {
  return tx
    .select({ id: schema.pageVersion.id, createdAt: schema.pageVersion.createdAt, authorId: schema.pageVersion.authorId })
    .from(schema.pageVersion)
    .where(eq(schema.pageVersion.pageId, pageId))
    .orderBy(desc(schema.pageVersion.createdAt));
}

export async function getPageVersionSnapshot(tx: Tx, pageId: string, versionId: string) {
  const [row] = await tx
    .select({ snapshot: schema.pageVersion.snapshot })
    .from(schema.pageVersion)
    .where(and(eq(schema.pageVersion.id, versionId), eq(schema.pageVersion.pageId, pageId)));
  if (!row) return null;
  return row.snapshot;
}
