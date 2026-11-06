import { pgTable, text, boolean, integer, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { project } from "./project";
import type { Json } from "./_shared";

export const importSource = ["jira", "notion"] as const;
export type ImportSource = (typeof importSource)[number];

export const jiraMigrationStates = ["draft", "discovering", "ready", "running", "synced", "completed", "failed"] as const;
export type JiraMigrationState = (typeof jiraMigrationStates)[number];

/**
 * One row per Kompast project that's being (or was) migrated from a JIRA
 * project. Unlike import_run (one row per run), this is the long-lived
 * record the migration wizard and the batched background runner both read:
 * credentials, the discovery snapshot, the saved mapping, and the cursor
 * that lets a run resume across worker ticks.
 *
 * `apiTokenEncrypted` is the JIRA API token, encrypted with
 * packages/core/src/crypto.ts (same as system_settings secrets). It's
 * cleared when the migration finishes (`tokenClearedAt` records when), so a
 * completed migration holds no live credential. Never returned by read APIs.
 *
 * `leaseExpiresAt` is the worker lease: apps/worker claims a row for a few
 * minutes at a time, so two worker processes never run the same migration.
 */
export const jiraMigration = pgTable(
  "jira_migration",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** The Kompast board the imported sprints and issues land on. Bare id, no FK, matching how import_run/external_ref treat their references. */
    boardId: text("board_id").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    /** JIRA site base URL, no trailing slash. */
    siteUrl: text("site_url").notNull(),
    email: text("email").notNull(),
    apiTokenEncrypted: text("api_token_encrypted"),
    tokenClearedAt: timestamp("token_cleared_at"),
    jiraProjectKey: text("jira_project_key").notNull(),
    jiraBoardId: integer("jira_board_id"),
    state: text("state", { enum: jiraMigrationStates }).notNull().default("draft"),
    /** JiraDiscovery snapshot (packages/import/src/jira/discover.ts), written by the discovering step. */
    discovery: jsonb("discovery").$type<Json>(),
    /** JiraMigrationMapping (packages/import/src/jira/mapping.ts) — the user-confirmed status/type/people mapping. */
    mapping: jsonb("mapping").$type<Json>(),
    progress: jsonb("progress").$type<Json>(),
    /** Runner resume state: the next JIRA page token, pages done, prepared sprint/status ids, deferred links/parents. */
    cursor: jsonb("cursor").$type<Json>(),
    lastSyncedAt: timestamp("last_synced_at"),
    /**
     * Auto-sync interval in minutes: null (off), 15, 60 or 240. A worker starts a sync in sync mode, as the creator,
     * once a synced migration's lastSyncedAt + this many minutes has passed and it still has its token.
     */
    autoSyncMinutes: integer("auto_sync_minutes"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jira_migration_project_uq").on(t.projectId),
    index("jira_migration_project_idx").on(t.projectId),
    index("jira_migration_state_idx").on(t.state),
  ],
);

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
    /**
     * Null for page importers (Notion): they target a docs space, not a
     * project. RLS then shows the run to its creator only (rls.sql), since
     * there's no project to inherit visibility from.
     */
    projectId: text("project_id").references(() => project.id, { onDelete: "cascade" }),
    source: text("source", { enum: importSource }).notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    status: text("status", { enum: ["pending", "running", "completed", "failed"] })
      .notNull()
      .default("pending"),
    config: jsonb("config").$type<Json>().notNull(),
    counts: jsonb("counts").$type<Json>(),
    errors: jsonb("errors").$type<Json>(),
    /**
     * Informational notes from a run (e.g. "renumbered to KEY-n: number already used"). Kept apart from
     * `errors` so a note never counts as a failure.
     */
    notes: jsonb("notes").$type<Json>(),
    createdBy: text("created_by").references(() => user.id),
    /** Set for runs started by a JIRA migration (jira_migration). Null for one-shot imports and Notion. */
    migrationId: text("migration_id").references(() => jiraMigration.id, { onDelete: "set null" }),
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
    entityType: text("entity_type", { enum: ["issue", "page", "sprint", "comment", "worklog", "attachment", "user"] }).notNull(),
    entityId: text("entity_id").notNull(),
    importRunId: text("import_run_id").references(() => importRun.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("external_ref_source_uq").on(t.organizationId, t.source, t.sourceId),
    index("external_ref_entity_idx").on(t.entityType, t.entityId),
  ],
);
