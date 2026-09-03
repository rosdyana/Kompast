import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { project } from "./project";
import { issueType, workflowStatus } from "./workflow";
import { rank, type Json } from "./_shared";

export const issue = pgTable(
  "issue",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** Sequential per-project counter backing the human-facing KPT-123 key. */
    keySeq: integer("key_seq").notNull(),
    typeId: text("type_id")
      .notNull()
      .references(() => issueType.id),
    statusId: text("status_id")
      .notNull()
      .references(() => workflowStatus.id),
    parentId: text("parent_id"),
    epicId: text("epic_id"),
    title: text("title").notNull(),
    /** BlockNote document JSON. */
    /** BlockNote document JSON (P2) — untyped placeholder until that schema exists. */
    descriptionJson: jsonb("description_json").$type<Json | null>(),
    assigneeId: text("assignee_id").references(() => user.id),
    reporterId: text("reporter_id")
      .notNull()
      .references(() => user.id),
    priority: text("priority", { enum: ["lowest", "low", "medium", "high", "highest"] })
      .notNull()
      .default("medium"),
    storyPoints: integer("story_points"),
    estimateSeconds: integer("estimate_seconds"),
    spentSeconds: integer("spent_seconds").notNull().default(0),
    startDate: timestamp("start_date"),
    dueDate: timestamp("due_date"),
    rank: rank("rank").notNull(),
    sprintId: text("sprint_id"),
    labels: text("labels").array().notNull().default([]),
    customFields: jsonb("custom_fields").$type<Json>().notNull().default({}),
    /** 'user' | 'automation' | 'mcp' | 'api' | 'import' — see plan §"REST API + MCP" attribution. */
    origin: text("origin").notNull().default("user"),
    originClient: text("origin_client"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("issue_project_key_uq").on(t.projectId, t.keySeq),
    index("issue_status_idx").on(t.statusId),
    index("issue_assignee_idx").on(t.assigneeId),
    index("issue_custom_fields_gin").using("gin", t.customFields),
  ],
);

export const issueLink = pgTable("issue_link", {
  id: text("id").primaryKey(),
  fromIssueId: text("from_issue_id")
    .notNull()
    .references(() => issue.id, { onDelete: "cascade" }),
  toIssueId: text("to_issue_id")
    .notNull()
    .references(() => issue.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["blocks", "relates", "duplicates", "clones"] }).notNull(),
});

export const issueWatcher = pgTable(
  "issue_watcher",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("issue_watcher_uq").on(t.issueId, t.userId)],
);

export const issueComment = pgTable("issue_comment", {
  id: text("id").primaryKey(),
  issueId: text("issue_id")
    .notNull()
    .references(() => issue.id, { onDelete: "cascade" }),
  authorId: text("author_id")
    .notNull()
    .references(() => user.id),
  bodyJson: jsonb("body_json").$type<Json>().notNull(),
  origin: text("origin").notNull().default("user"),
  originClient: text("origin_client"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const issueAttachment = pgTable("issue_attachment", {
  id: text("id").primaryKey(),
  issueId: text("issue_id")
    .notNull()
    .references(() => issue.id, { onDelete: "cascade" }),
  uploaderId: text("uploader_id")
    .notNull()
    .references(() => user.id),
  /** GCS object key (packages/storage). */
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const worklog = pgTable("worklog", {
  id: text("id").primaryKey(),
  issueId: text("issue_id")
    .notNull()
    .references(() => issue.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  seconds: integer("seconds").notNull(),
  note: text("note"),
  loggedAt: timestamp("logged_at").notNull().defaultNow(),
});

/**
 * Field-level change log. Written in the same transaction as the mutation
 * that caused it — this table drives both the activity feed and every
 * report (burndown, cycle time), so it cannot be reconstructed after the
 * fact from `issue`'s current row alone.
 */
export const issueHistory = pgTable(
  "issue_history",
  {
    id: text("id").primaryKey(),
    issueId: text("issue_id")
      .notNull()
      .references(() => issue.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => user.id),
    origin: text("origin").notNull().default("user"),
    originClient: text("origin_client"),
    field: text("field").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("issue_history_issue_idx").on(t.issueId)],
);
