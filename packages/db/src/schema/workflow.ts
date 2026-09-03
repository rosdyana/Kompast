import { pgTable, text, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { project } from "./project";

export const issueType = pgTable("issue_type", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  icon: text("icon").notNull(),
  color: text("color").notNull(),
  /** epic=0, story/task/bug=1, subtask=2 — governs valid parent/child nesting. */
  hierarchyLevel: integer("hierarchy_level").notNull().default(1),
  isSubtask: boolean("is_subtask").notNull().default(false),
});

/**
 * `category` is what every burndown/CFD/velocity report groups by — it is
 * the ground truth, independent of whatever a column happens to be named.
 * See plan: "Categories are what make burndown correct".
 */
export const statusCategory = ["todo", "in_progress", "done"] as const;
export type StatusCategory = (typeof statusCategory)[number];

export const workflowStatus = pgTable("workflow_status", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category", { enum: statusCategory }).notNull(),
  color: text("color").notNull(),
  order: integer("order").notNull().default(0),
});

export const workflowTransition = pgTable("workflow_transition", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => project.id, { onDelete: "cascade" }),
  fromStatusId: text("from_status_id").references(() => workflowStatus.id, {
    onDelete: "cascade",
  }),
  toStatusId: text("to_status_id")
    .notNull()
    .references(() => workflowStatus.id, { onDelete: "cascade" }),
  name: text("name"),
  /** { conditions: [...], validators: [...], postFunctions: [...] } */
  rules: text("rules"),
});
