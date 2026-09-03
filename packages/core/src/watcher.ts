import { and, eq, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export async function setWatching(tx: Tx, input: { issueId: string; userId: string; watching: boolean }) {
  if (input.watching) {
    await tx
      .insert(schema.issueWatcher)
      .values({ id: id("watch"), issueId: input.issueId, userId: input.userId })
      .onConflictDoNothing();
  } else {
    await tx
      .delete(schema.issueWatcher)
      .where(and(eq(schema.issueWatcher.issueId, input.issueId), eq(schema.issueWatcher.userId, input.userId)));
  }
}

export async function listWatchers(tx: Tx, issueId: string) {
  return tx
    .select({ userId: schema.issueWatcher.userId })
    .from(schema.issueWatcher)
    .where(eq(schema.issueWatcher.issueId, issueId));
}
