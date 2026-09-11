import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { project } from "./project";

/**
 * A project's priority scale. Not a fixed DB enum — editable per project
 * (rename, recolor, reorder) via Settings, same shape as workflow_status/
 * issue_type. `key` is a stable slug generated once at creation and never
 * renamed afterward — it's what issue.priority actually stores, so renaming
 * only ever changes the display label, never any issue row (same convention
 * as issue_property_definition.key).
 */
export const priorityLevel = pgTable(
  "priority_level",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    order: integer("order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("priority_level_project_key_uq").on(t.projectId, t.key)],
);
