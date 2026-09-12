/**
 * The TableViewConfig shape + its pure normalizer — deliberately dependency-
 * free (no @kompast/db import) so client components (TableView.tsx,
 * KompastViewBlock.tsx) can import this exact module (via the
 * "@kompast/core/table-view-config" subpath export) without pulling
 * @kompast/db's Node-only `postgres` client into the browser bundle, the
 * same way @kompast/core/ids and @kompast/core/collab-token already do for
 * their own callers. saved-view.ts re-exports everything here for
 * server-side callers going through the main "@kompast/core" barrel.
 */

/** "manual" sorts by the table's own drag-and-drop rank (issue.rank, or sprint_issue.rank in the Sprint Review context) rather than any issue field. */
export type SortField = "manual" | "priority" | "dueDate" | "points" | "key";

export interface SortRule {
  field: SortField;
  direction: "asc" | "desc";
}

export type FilterField = "column" | "assignee" | "priority" | "type" | "points" | "dueDate" | "title";

export type FilterOperator =
  | "is"
  | "isNot"
  | "isAnyOf"
  | "contains"
  | "doesNotContain"
  | "isEmpty"
  | "isNotEmpty"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "before"
  | "after";

export interface FilterCondition {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  /** string | string[] | number | null depending on field+operator — the UI (FilterBuilder) and evaluator (table-filters.ts) agree on the shape per field. */
  value: unknown;
}

export interface TableViewConfig {
  groupBy: "column" | "assignee" | "none";
  /** Ordered by priority — the first rule is the primary sort, later rules break ties. */
  sort: SortRule[];
  /** ANDed together — every condition must match for a row to show. No OR/grouping (deliberately out of scope). */
  filters: FilterCondition[];
}

export const DEFAULT_TABLE_VIEW_CONFIG: TableViewConfig = {
  groupBy: "column",
  sort: [{ field: "manual", direction: "asc" }],
  filters: [],
};

/** The shape every saved_view.config row had before multi-sort/filters shipped. */
interface LegacyTableViewConfig {
  groupBy: "column" | "assignee" | "none";
  sortBy: "rank" | "priority" | "dueDate" | "points" | "key";
  sortDir: "asc" | "desc";
}

/**
 * Upgrades whatever shape is actually stored in saved_view.config (jsonb,
 * unvalidated at rest) into the current TableViewConfig shape. No
 * destructive migration was run against existing rows — a saved_view
 * written before this shipped keeps its old {sortBy, sortDir} shape until
 * it's next saved through updateSavedViewConfig, so every reader must go
 * through this rather than casting the jsonb value directly.
 */
export function normalizeTableViewConfig(raw: unknown): TableViewConfig {
  const config = (raw ?? {}) as Partial<TableViewConfig> & Partial<LegacyTableViewConfig>;
  const groupBy = config.groupBy ?? DEFAULT_TABLE_VIEW_CONFIG.groupBy;
  const filters = Array.isArray(config.filters) ? (config.filters as FilterCondition[]) : [];

  if (Array.isArray(config.sort) && config.sort.length > 0) {
    return { groupBy, sort: config.sort, filters };
  }
  if (config.sortBy) {
    const field: SortField = config.sortBy === "rank" ? "manual" : config.sortBy;
    return { groupBy, sort: [{ field, direction: config.sortDir ?? "asc" }], filters };
  }
  return { groupBy, sort: DEFAULT_TABLE_VIEW_CONFIG.sort, filters };
}
