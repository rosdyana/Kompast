import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, jsonb, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth";
import { project } from "./project";
import { sprint } from "./sprint";
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
    /**
     * A page lives in exactly one "space": a project (projectId set — its
     * team comes from the project, deliberately not denormalized here, so
     * moving a project between teams never needs a page rewrite), a team
     * (teamId set), a user's Private space (privateOwnerId set), or the
     * shared Workspace space (all null, visible to every member). The check
     * constraint below allows at most one of the three;
     * keeping a child page in its parent's space is enforced in
     * packages/core/src/page.ts. RLS (packages/db/rls.sql) reads both.
     */
    projectId: text("project_id").references(() => project.id, { onDelete: "cascade" }),
    /**
     * `no action`, not `set null`: nulling this would silently move a
     * team's private pages into the everyone-visible Workspace space —
     * failing open. Deleting a team directly is refused while it still owns
     * pages (there is no team-delete flow today; one would have to move or
     * delete them first). Deliberately not `restrict`: Postgres checks that
     * immediately, which breaks deleting a whole organization, where the
     * same cascade removes both the team and its pages — `no action` is
     * checked at end of statement, after the pages are gone too.
     */
    teamId: text("team_id").references(() => team.id, { onDelete: "no action" }),
    /**
     * Private space (Notion's "Private" sidebar section): set = visible to
     * this one user only, the super admin included — RLS compares it to
     * app.current_user, so it is also impossible to create or move a page
     * into someone else's Private space. Cascade on user delete: nobody
     * else could ever open these pages, so keeping them would only leave
     * unreachable rows behind.
     */
    privateOwnerId: text("private_owner_id").references(() => user.id, { onDelete: "cascade" }),
    /**
     * Notion's "Shared" section: a privately owned page tree the owner has
     * invited specific people into. Non-empty only alongside privateOwnerId.
     * A denormalized copy of the user grants on the tree's root
     * page_permission rows, kept on every page of the tree, because the page
     * RLS policy can't read page_permission itself: that table's own policy
     * reads page, and Postgres rejects policies that recurse into each
     * other. Written only by packages/core/src/page-permission.ts
     * (syncSharedWith); roles still come from page_permission.
     */
    sharedWith: text("shared_with").array().notNull().default(sql`'{}'::text[]`),
    /** Null = not a sprint's meeting-minutes doc. Set once, at creation, by createSprint. */
    sprintId: text("sprint_id").references(() => sprint.id, { onDelete: "cascade" }),
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
  (t) => [
    index("page_parent_idx").on(t.parentPageId),
    index("page_project_idx").on(t.projectId),
    index("page_sprint_idx").on(t.sprintId),
    index("page_team_idx").on(t.teamId),
    index("page_private_owner_idx").on(t.privateOwnerId),
    index("page_shared_with_idx").using("gin", t.sharedWith),
    check("page_shared_needs_owner_ck", sql`cardinality(${t.sharedWith}) = 0 or ${t.privateOwnerId} is not null`),
    check(
      "page_single_space_ck",
      sql`num_nonnulls(${t.teamId}, ${t.projectId}, ${t.privateOwnerId}) <= 1`,
    ),
  ],
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
