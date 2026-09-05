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
     * Forward-looking, not used yet: no property created by this pass's UI
     * has isCore=true, and createProject's seed doesn't insert any row into
     * this table at all. Reserved for a future first-class field
     * deliberately folded into customFields (see schema/index.ts's own
     * comment on version/component) that needs delete-protection because
     * something else (e.g. the Timeline view or a built-in automation rule)
     * depends on it existing.
     */
    isCore: boolean("is_core").notNull().default(false),
    order: integer("order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("issue_property_definition_project_key_uq").on(t.projectId, t.key)],
);
