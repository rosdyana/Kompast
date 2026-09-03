import { generateKeyBetween } from "fractional-indexing";

/**
 * Fractional-index rank for drag-and-drop ordering. Moving a card is always
 * a single-row write — never a bulk renumber of the column it lands in.
 * Re-exported thinly so callers depend on @kompast/core, not directly on
 * the fractional-indexing package (keeps the algorithm swappable).
 */
export function rankBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

export const FIRST_RANK = rankBetween(null, null);
