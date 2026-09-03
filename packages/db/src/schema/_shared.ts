import { customType } from "drizzle-orm/pg-core";

/**
 * Fractional-index rank for drag-and-drop ordering (LexoRank-style string).
 * Stored as text so re-ranking a single card is a single-row write, never
 * a bulk renumber of the whole column.
 */
export const rank = customType<{ data: string }>({
  dataType() {
    return "text";
  },
});
