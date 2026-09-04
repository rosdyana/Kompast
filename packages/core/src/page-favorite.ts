import { and, eq, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export async function toggleFavoritePage(tx: Tx, pageId: string, userId: string) {
  const [existing] = await tx
    .select({ id: schema.pageFavorite.id })
    .from(schema.pageFavorite)
    .where(and(eq(schema.pageFavorite.pageId, pageId), eq(schema.pageFavorite.userId, userId)));

  if (existing) {
    await tx.delete(schema.pageFavorite).where(eq(schema.pageFavorite.id, existing.id));
    return { favorited: false };
  }

  await tx.insert(schema.pageFavorite).values({ id: id("pagefav"), pageId, userId });
  return { favorited: true };
}

export async function listFavoritePageIds(tx: Tx, userId: string) {
  const rows = await tx.select({ pageId: schema.pageFavorite.pageId }).from(schema.pageFavorite).where(eq(schema.pageFavorite.userId, userId));
  return rows.map((r) => r.pageId);
}
