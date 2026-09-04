import { pgTable, text, timestamp, boolean, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { project } from "./project";
import { rank, bytea, type Json } from "./_shared";

/**
 * The Notion half. `parentPageId` has no FK (Drizzle self-references need
 * an AnyPgColumn escape hatch that isn't worth it here — same call already
 * made for issue.parentId/epicId) so page moves/deletes are enforced in
 * packages/core, not by the database.
 */
export const page = pgTable(
  "page",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Null = workspace-level doc, not filed under a project. */
    projectId: text("project_id").references(() => project.id, { onDelete: "cascade" }),
    parentPageId: text("parent_page_id"),
    title: text("title").notNull().default(""),
    icon: text("icon"),
    cover: text("cover"),
    type: text("type", { enum: ["doc", "template"] }).notNull().default("doc"),
    /** Fractional index among siblings sharing the same parentPageId (see board issue.rank). */
    rank: rank("rank").notNull(),
    archivedAt: timestamp("archived_at"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("page_parent_idx").on(t.parentPageId), index("page_project_idx").on(t.projectId)],
);

/**
 * Hocuspocus persistence: one row per page holding the latest full Yjs
 * document state. Written by apps/collab on every debounced store, never
 * by apps/web directly.
 */
export const ydocState = pgTable("ydoc_state", {
  pageId: text("page_id")
    .primaryKey()
    .references(() => page.id, { onDelete: "cascade" }),
  state: bytea("state").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Named/periodic snapshots for history + restore — distinct from ydoc_state's single live copy. */
export const pageVersion = pgTable(
  "page_version",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    snapshot: bytea("snapshot").notNull(),
    authorId: text("author_id").references(() => user.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("page_version_page_idx").on(t.pageId)],
);

/**
 * Presence of ANY row for a page marks it "restricted": only listed
 * subjects (plus workspace admins) may access it. A page with zero rows
 * here is open to every organization member — the same implicit default
 * every other P1 entity (project, board) already has, so docs don't
 * introduce a stricter default than boards without being asked to.
 */
export const pagePermission = pgTable(
  "page_permission",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    subjectType: text("subject_type", { enum: ["user", "team"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    role: text("role", { enum: ["view", "comment", "edit", "full"] }).notNull().default("view"),
  },
  (t) => [uniqueIndex("page_permission_uq").on(t.pageId, t.subjectType, t.subjectId)],
);

/**
 * Guest access is deliberately outside RLS/session auth entirely (see plan
 * §Auth, "Guests are not sessions"): resolved via packages/core/share-link
 * against the admin connection, with the token itself as the only
 * credential — verified in application code, the same trust model the
 * local storage driver already uses for signed attachment URLs.
 */
export const shareLink = pgTable("share_link", {
  id: text("id").primaryKey(),
  pageId: text("page_id")
    .notNull()
    .references(() => page.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  scope: text("scope", { enum: ["view", "comment"] }).notNull().default("view"),
  passwordHash: text("password_hash"),
  /** Whether a kompastView embed inside this page renders for guests (see plan: frozen snapshot only). */
  includeEmbeds: boolean("include_embeds").notNull().default(false),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const pageComment = pgTable(
  "page_comment",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    /** BlockNote block id the comment is anchored to. */
    blockId: text("block_id").notNull(),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    bodyJson: jsonb("body_json").$type<Json>().notNull(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("page_comment_page_idx").on(t.pageId)],
);

export const pageFavorite = pgTable(
  "page_favorite",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => page.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("page_favorite_uq").on(t.pageId, t.userId)],
);

/**
 * Polymorphic doc<->issue linking, @mentions, and backlinks — all one
 * table (see plan §Data model, "link"). A backlinks panel is just a
 * reverse query: `where to_type = 'page' and to_id = :pageId`.
 */
export const link = pgTable(
  "link",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    fromType: text("from_type", { enum: ["page", "issue"] }).notNull(),
    fromId: text("from_id").notNull(),
    toType: text("to_type", { enum: ["page", "issue"] }).notNull(),
    toId: text("to_id").notNull(),
    /** 'reference' = explicit "linked doc/issue" action; 'mention' = inline @mention found in doc content. */
    kind: text("kind", { enum: ["reference", "mention"] }).notNull().default("reference"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("link_uq").on(t.fromType, t.fromId, t.toType, t.toId, t.kind),
    index("link_to_idx").on(t.toType, t.toId),
  ],
);
