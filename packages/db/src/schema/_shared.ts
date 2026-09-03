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

/**
 * A genuinely JSON-safe value — unlike `Record<string, unknown>`, this
 * can't hide a function or class instance in a nested field, which matters
 * because server functions (apps/web) reject non-serializable return
 * values at the type level. Use `.$type<Json>()` on every jsonb column.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
