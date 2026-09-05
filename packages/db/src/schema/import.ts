import { pgTable, text, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { project } from "./project";
import type { Json } from "./_shared";

export const importSource = ["jira", "notion"] as const;
export type ImportSource = (typeof importSource)[number];

/**
 * One row per importer invocation (dry-run or real). `config` holds only
 * non-secret parameters (project key, base URL, Notion page id) — the
 * source credential (JIRA API token, Notion integration token) is never
 * persisted here; it's passed at call time and never written to the DB,
 * same treatment as any other third-party API key in this codebase.
 * `counts`/`errors` are the reconciliation report the plan calls for:
 * "counts in vs counts out, unresolved links, skipped blocks" — written
 * once the run finishes (or fails partway), not streamed incrementally.
 */
export const importRun = pgTable(
  "import_run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    source: text("source", { enum: importSource }).notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    status: text("status", { enum: ["pending", "running", "completed", "failed"] })
      .notNull()
      .default("pending"),
    config: jsonb("config").$type<Json>().notNull(),
    counts: jsonb("counts").$type<Json>(),
    errors: jsonb("errors").$type<Json>(),
    createdBy: text("created_by").references(() => user.id),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("import_run_project_idx").on(t.projectId), index("import_run_status_idx").on(t.status)],
);

/**
 * Maps one external (source, sourceId) pair to the Kompast row it became.
 * The unique index on (organizationId, source, sourceId) is what makes a
 * re-run idempotent: the loader always upserts by this key rather than
 * blindly inserting, so importing the same JIRA project or Notion page
 * twice updates existing rows instead of duplicating them. Also what a
 * second pass uses to rewrite an internal `notion.so`/JIRA-issue-key link
 * once every referenced page/issue is guaranteed to exist.
 */
export const externalRef = pgTable(
  "external_ref",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    source: text("source", { enum: importSource }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceUrl: text("source_url"),
    entityType: text("entity_type", { enum: ["issue", "page"] }).notNull(),
    entityId: text("entity_id").notNull(),
    importRunId: text("import_run_id").references(() => importRun.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("external_ref_source_uq").on(t.organizationId, t.source, t.sourceId),
    index("external_ref_entity_idx").on(t.entityType, t.entityId),
  ],
);
