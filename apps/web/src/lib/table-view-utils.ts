import type { FilterCondition, FilterField, SortField, SortRule } from "@kompast/core/table-view-config";

/**
 * Shared by TableView.tsx (the interactive Sprint Review / Table tab) and
 * KompastViewBlock.tsx (the read-only doc embed) — both render a flattened
 * view of the same BoardData shape, and both need to sort/filter it
 * identically since they read the exact same saved_view config (see
 * packages/db/src/schema/board.ts's savedView doc comment: "the single
 * object behind board mode, table mode, and doc-page embeds").
 */
export interface SortableFlatIssue {
  rank: string;
  /** This sprint's own manual-reorder rank (sprint_issue.rank) — only present when rendering a sprint-scoped view; "manual" sort falls back to `rank` (issue.rank) otherwise. */
  sprintRank?: string | null;
  priority: string;
  dueDate: string | Date | null;
  storyPoints: number | null;
  keySeq: number;
}

export interface FilterableFlatIssue {
  columnName: string;
  assigneeId: string | null;
  priority: string;
  typeId: string;
  storyPoints: number | null;
  dueDate: string | Date | null;
  title: string;
}

/**
 * `priority_level.order` is ascending-severity (0 = lowest). The table's
 * "Sort: Priority" wants descending severity (highest first), so invert:
 * the level with `order: 0` gets the highest index, sorting last.
 */
export function priorityOrderByKey(priorityLevels: { key: string; order: number }[]): Record<string, number> {
  const sorted = [...priorityLevels].sort((a, b) => a.order - b.order);
  return Object.fromEntries(sorted.map((p, i, arr) => [p.key, arr.length - 1 - i]));
}

function compareByField(a: SortableFlatIssue, b: SortableFlatIssue, field: SortField, priorityOrder: Record<string, number>): number {
  if (field === "manual") {
    const aRank = a.sprintRank ?? a.rank;
    const bRank = b.sprintRank ?? b.rank;
    return aRank < bRank ? -1 : aRank > bRank ? 1 : 0;
  }
  if (field === "priority") return (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99);
  if (field === "dueDate") {
    const aTime = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const bTime = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    return aTime - bTime;
  }
  if (field === "points") return (a.storyPoints ?? -1) - (b.storyPoints ?? -1);
  return a.keySeq - b.keySeq; // "key"
}

/** Multi-column sort: rules are applied in priority order, the first non-zero comparison wins. */
export function sortIssues<T extends SortableFlatIssue>(issues: T[], sort: SortRule[], priorityOrder: Record<string, number>): T[] {
  const rules = sort.length > 0 ? sort : [{ field: "manual" as const, direction: "asc" as const }];
  return [...issues].sort((a, b) => {
    for (const rule of rules) {
      const cmp = compareByField(a, b, rule.field, priorityOrder);
      if (cmp !== 0) return rule.direction === "asc" ? cmp : -cmp;
    }
    return 0;
  });
}

function fieldValue(issue: FilterableFlatIssue, field: FilterField): string | number | null {
  switch (field) {
    case "column":
      return issue.columnName;
    case "assignee":
      return issue.assigneeId;
    case "priority":
      return issue.priority;
    case "type":
      return issue.typeId;
    case "points":
      return issue.storyPoints;
    case "dueDate":
      return issue.dueDate ? new Date(issue.dueDate).getTime() : null;
    case "title":
      return issue.title;
  }
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function matchesCondition(value: string | number | null, condition: FilterCondition): boolean {
  if (condition.operator === "isEmpty") return isEmptyValue(value);
  if (condition.operator === "isNotEmpty") return !isEmptyValue(value);
  if (isEmptyValue(value)) return false; // every remaining operator needs a real value to compare against

  const target = condition.value;
  switch (condition.operator) {
    case "is":
      return Array.isArray(target) ? target.includes(value) : value === target;
    case "isNot":
      return Array.isArray(target) ? !target.includes(value) : value !== target;
    case "isAnyOf":
      return Array.isArray(target) && target.includes(value);
    case "contains":
      return typeof value === "string" && typeof target === "string" && value.toLowerCase().includes(target.toLowerCase());
    case "doesNotContain":
      return typeof value === "string" && typeof target === "string" && !value.toLowerCase().includes(target.toLowerCase());
    case "gt":
      return typeof value === "number" && typeof target === "number" && value > target;
    case "gte":
      return typeof value === "number" && typeof target === "number" && value >= target;
    case "lt":
      return typeof value === "number" && typeof target === "number" && value < target;
    case "lte":
      return typeof value === "number" && typeof target === "number" && value <= target;
    case "before":
      return typeof value === "number" && typeof target === "string" && value < new Date(target).getTime();
    case "after":
      return typeof value === "number" && typeof target === "string" && value > new Date(target).getTime();
    default:
      return true;
  }
}

/** ANDed together — every condition must match for a row to show. No OR/grouping (deliberately out of scope). */
export function applyFilters<T extends FilterableFlatIssue>(issues: T[], filters: FilterCondition[]): T[] {
  if (filters.length === 0) return issues;
  return issues.filter((issue) => filters.every((condition) => matchesCondition(fieldValue(issue, condition.field), condition)));
}

/**
 * Resolves a drag-and-drop move within a flat, already-ordered id list into
 * the {beforeIssueId, afterIssueId} shape reorderSprintIssue/moveIssue
 * expect — "before" is whichever neighbor should sort earlier than the
 * dragged row's new position, "after" whichever should sort later (matching
 * rankBetween's own before/after — i.e. lower-bound/upper-bound —
 * parameters). Dragging past a row places the dragged row on the far side
 * of it: past-and-down lands it immediately after that row, past-and-up
 * immediately before.
 */
export function computeReorderTargets(orderedIds: string[], activeId: string, overId: string): { beforeIssueId?: string; afterIssueId?: string } {
  const activeIndex = orderedIds.indexOf(activeId);
  const overIndex = orderedIds.indexOf(overId);
  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) return {};

  if (activeIndex < overIndex) {
    return { beforeIssueId: overId, afterIssueId: orderedIds[overIndex + 1] };
  }
  return { afterIssueId: overId, beforeIssueId: orderedIds[overIndex - 1] };
}
