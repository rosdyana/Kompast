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
    /** Short uppercase prefix used in issue keys, e.g. "KPT" -> KPT-123. Unique per workspace. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    leadId: text("lead_id").references(() => user.id),
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("project_org_key_uq").on(t.organizationId, t.key)],
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
