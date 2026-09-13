import { pgTable, text, integer, boolean, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { project } from "./project";
import type { Json } from "./_shared";

/** ~9 types, informed by what's practical to store in issue.customFields jsonb and validate. */
export const issuePropertyType = [
  "text",
  "textarea",
  "number",
  "date",
  "checkbox",
  "select",
  "multiSelect",
  "url",
  "person",
] as const;

/**
 * A project's custom-field schema. issue.customFields (jsonb) stores values
 * keyed by `key`, never by `id` or `name` — see this table's own `key`
 * column comment for why that must never change once issued.
 */
export const issuePropertyDefinition = pgTable(
  "issue_property_definition",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /**
     * Stable slug into issue.customFields — generated once from `name` at
     * creation and never changed afterward, so renaming a property (unlike
     * retyping/hiding) never requires touching a single `issue` row, exactly
     * like renaming a board_column never touches one (see board.ts's own
     * comment on that). "jira" is reserved (packages/import's JIRA importer
     * already writes issue.customFields.jira.*).
     */
    key: text("key").notNull(),
    name: text("name").notNull(),
    type: text("type", { enum: issuePropertyType }).notNull(),
    /** [{ value, label, color? }, ...] — only meaningful for select/multiSelect; null otherwise. */
    options: jsonb("options").$type<Json>(),
    visibleOnCard: boolean("visible_on_card").notNull().default(false),
    /**
     * True for the project's 8 built-in issue-detail fields (assignee,
     * reporter, priority, startDate, dueDate, epic, sprint, storyPoints),
     * seeded by createProject (packages/core/src/project.ts's
     * CORE_ISSUE_PROPERTIES) and backfilled for pre-existing projects by
     * drizzle/0021_backfill_core_issue_properties.sql. These rows exist so
     * core fields share the same reorder mechanism as custom properties;
     * their `type`/`options` are metadata only — the issue-detail page
     * dispatches core rows to bespoke rendering by `key`, never through the
     * generic customFields editor. deleteIssuePropertyDefinition refuses to
     * delete them.
     */
    isCore: boolean("is_core").notNull().default(false),
    order: integer("order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("issue_property_definition_project_key_uq").on(t.projectId, t.key)],
);
