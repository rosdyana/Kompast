import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth";

export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => team.id, { onDelete: "set null" }),
    /**
     * Short uppercase prefix used in issue keys, e.g. "KPT" -> KPT-123.
     * Unique per team within a workspace (see `project_team_key_uq`) — two
     * different teams may use the same key. `teamId` NULL is a legacy
     * escape hatch (pre-team-admin-required projects); Postgres treats each
     * NULL as distinct, so two legacy NULL-team projects could in theory
     * share a key uncaught by this index. That's defended against in the
     * lookup code (throw on >1 match), not the schema.
     */
    key: text("key").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    leadId: text("lead_id").references(() => user.id),
    /** The project's one "Sprint Minutes Template" page — bare id, no FK (page.ts imports this file, so a FK back would cycle). Null until createProjectFn seeds it. */
    sprintMinutesTemplatePageId: text("sprint_minutes_template_page_id"),
    /** Same shape as sprintMinutesTemplatePageId, for the Sprint Retrospective doc — bare id, no FK, for the same cyclic-import reason. Null until createProjectFn seeds it. */
    sprintRetroTemplatePageId: text("sprint_retro_template_page_id"),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_team_key_uq").on(t.organizationId, t.teamId, t.key)],
);

export const projectMember = pgTable(
  "project_member",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Overrides the workspace-level role for this project only, e.g. 'lead' | 'contributor' | 'viewer'. */
    role: text("role").notNull().default("contributor"),
  },
  (t) => [uniqueIndex("project_member_uq").on(t.projectId, t.userId)],
);
