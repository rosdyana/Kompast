import { pgTable, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { board } from "./board";
import { issue } from "./issue";

/**
 * organizationId is denormalized here (rather than only reachable via
 * board -> project) because sprints are listed/queried directly across a
 * workspace (REST/MCP, reports) — same reasoning `issue` already denormalizes
 * it despite also carrying projectId. `board`/`board_column` don't need this
 * since nothing queries them outside a project's own context.
 */
export const sprint = pgTable(
  "sprint",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    boardId: text("board_id")
      .notNull()
      .references(() => board.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    goal: text("goal"),
    state: text("state", { enum: ["future", "active", "closed"] }).notNull().default("future"),
    cycle: text("cycle", { enum: ["1w", "2w", "3w", "4w", "custom"] }).notNull().default("2w"),
    startAt: timestamp("start_at"),
    endAt: timestamp("end_at"),
    capacityPoints: integer("capacity_points"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sprint_board_idx").on(t.boardId), index("sprint_org_idx").on(t.organizationId)],
);

/**
 * Sprint membership HISTORY, not just current state — `issue.sprintId` (bare
 * text, no FK, same convention as parentId/epicId) already answers "what
 * sprint is this issue in right now"; this table is what makes carry-over
 * reporting and scope-creep honest: `plannedAtStart` distinguishes an issue
 * that was in scope when the sprint started from one added mid-sprint, and
 * `removedAt` records an issue moved out (carried to the next sprint, or
 * pulled back to the backlog) without losing that it was ever there.
 */
export const sprintIssue = pgTable(
  "sprint_issue",
  {
    id: text("id").primaryKey(),
    sprintId: text("sprint_id")
      .notNull()
      .references(() => sprint.id, { onDelete: "cascade" }),
    issueId: text("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    plannedAtStart: boolean("planned_at_start").notNull().default(false),
    addedAt: timestamp("added_at").notNull().defaultNow(),
    removedAt: timestamp("removed_at"),
  },
  (t) => [index("sprint_issue_sprint_idx").on(t.sprintId), index("sprint_issue_issue_idx").on(t.issueId)],
);

/**
 * A point-in-time scope+completion snapshot. Written once at sprint start
 * (the baseline) and once at sprint completion (the outcome) by
 * startSprint/completeSprint — not by a cron job in this pass, so burndown
 * for an ACTIVE sprint is computed live from issue_history instead of from
 * daily snapshots (see packages/core/src/sprint-report.ts).
 */
export const sprintSnapshot = pgTable(
  "sprint_snapshot",
  {
    id: text("id").primaryKey(),
    sprintId: text("sprint_id")
      .notNull()
      .references(() => sprint.id, { onDelete: "cascade" }),
    takenAt: timestamp("taken_at").notNull().defaultNow(),
    kind: text("kind", { enum: ["start", "complete"] }).notNull(),
    scopeIssueCount: integer("scope_issue_count").notNull(),
    scopePoints: integer("scope_points").notNull(),
    completedIssueCount: integer("completed_issue_count").notNull(),
    completedPoints: integer("completed_points").notNull(),
  },
  (t) => [index("sprint_snapshot_sprint_idx").on(t.sprintId)],
);
