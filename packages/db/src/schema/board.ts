import { pgTable, text, integer, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { project } from "./project";
import { workflowStatus } from "./workflow";
import { user } from "./auth";
import type { Json } from "./_shared";

export const board = pgTable("board", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", { enum: ["kanban", "scrum"] }).notNull().default("kanban"),
  swimlaneBy: text("swimlane_by", { enum: ["none", "assignee", "epic", "priority"] })
    .notNull()
    .default("none"),
  /** { search, labels, assignees, ... } saved as the default quick-filter set. */
  quickFilters: jsonb("quick_filters").$type<Json>(),
  /** { cycle: '1w'|'2w'|'3w'|'4w'|'custom', customDays, startWeekday, autoCreateNext, carryOverPolicy } — consumed starting P4. */
  sprintDefaults: jsonb("sprint_defaults").$type<Json>(),
});

/**
 * A board's visible columns. Columns map to 1..n statuses (see
 * board_column_status) — exactly JIRA's model — so reordering or renaming a
 * column never touches an issue row.
 */
export const boardColumn = pgTable("board_column", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => board.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull(),
  order: integer("order").notNull().default(0),
  wipLimit: integer("wip_limit"),
  /** The one column new issues land in and that isn't user-deletable. */
  isBacklog: boolean("is_backlog").notNull().default(false),
});

export const boardColumnStatus = pgTable(
  "board_column_status",
  {
    id: text("id").primaryKey(),
    boardColumnId: text("board_column_id")
      .notNull()
      .references(() => boardColumn.id, { onDelete: "cascade" }),
    workflowStatusId: text("workflow_status_id")
      .notNull()
      .references(() => workflowStatus.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("board_column_status_uq").on(t.boardColumnId, t.workflowStatusId)],
);

/**
 * The single object behind board mode, table mode, and doc-page embeds
 * (custom BlockNote `kompastView` block). Two renderers, one query+config.
 */
export const savedView = pgTable("saved_view", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => board.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mode: text("mode", { enum: ["board", "table", "calendar", "timeline"] })
    .notNull()
    .default("board"),
  /** { visibleColumns, groupBy, sort, filters, swimlanes } */
  config: jsonb("config").$type<Json>().notNull(),
  createdBy: text("created_by").references(() => user.id),
});
