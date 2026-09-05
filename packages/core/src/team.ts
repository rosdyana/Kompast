import { and, count, eq, isNotNull, schema } from "@kompast/db";
import type { AnyDb, Tx } from "./types";

export type TeamMemberRole = "admin" | "member";

/**
 * Updates ONLY team_member.role — the one column Better Auth's org+teams
 * plugin doesn't know about. Never inserts/deletes team_member rows itself
 * and never touches team.memberCount (plugin-managed, "never write to this
 * directly" per packages/db/src/schema/auth.ts) — membership changes stay
 * exclusively the plugin's job via auth.api.addTeamMember/removeTeamMember
 * (apps/web/src/lib/server-fns/teams.ts).
 */
export async function setTeamMemberRole(
  db: AnyDb,
  input: { teamId: string; userId: string; role: TeamMemberRole },
): Promise<void> {
  const result = await db
    .update(schema.teamMember)
    .set({ role: input.role })
    .where(and(eq(schema.teamMember.teamId, input.teamId), eq(schema.teamMember.userId, input.userId)))
    .returning({ id: schema.teamMember.id });
  if (result.length === 0) {
    throw new Error(`User ${input.userId} is not a member of team ${input.teamId}`);
  }
}

export interface TeamSummary {
  id: string;
  name: string;
  memberCount: number;
  projectCount: number;
  /** This viewer's own team_member.role, or null if they aren't a member of this team at all. */
  myRole: TeamMemberRole | null;
}

/**
 * Workspace's teams for the sidebar tree. Takes a real Tx (from
 * withAuthorizedTenant), NOT plain db, even though team/team_member
 * themselves aren't RLS-scoped (see packages/db/rls.sql) — the
 * projectCount subquery reads `project`, which IS RLS-scoped, so this needs
 * to run inside a real workspace-scoped transaction. organizationId is
 * filtered explicitly on every query regardless of which table is/isn't
 * RLS'd, same defense-in-depth already used throughout
 * server-fns/members.ts and workspace.ts.
 */
export async function listTeamsForWorkspace(
  tx: Tx,
  ctx: { organizationId: string; userId: string },
): Promise<TeamSummary[]> {
  const teams = await tx
    .select({ id: schema.team.id, name: schema.team.name, memberCount: schema.team.memberCount })
    .from(schema.team)
    .where(eq(schema.team.organizationId, ctx.organizationId));

  const myMemberships = await tx
    .select({ teamId: schema.teamMember.teamId, role: schema.teamMember.role })
    .from(schema.teamMember)
    .innerJoin(schema.team, eq(schema.team.id, schema.teamMember.teamId))
    .where(and(eq(schema.team.organizationId, ctx.organizationId), eq(schema.teamMember.userId, ctx.userId)));
  const myRoleByTeam = new Map(myMemberships.map((m) => [m.teamId, m.role as TeamMemberRole]));

  const projectCounts = await tx
    .select({ teamId: schema.project.teamId, n: count() })
    .from(schema.project)
    .where(and(eq(schema.project.organizationId, ctx.organizationId), isNotNull(schema.project.teamId)))
    .groupBy(schema.project.teamId);
  const projectCountByTeam = new Map(projectCounts.map((p) => [p.teamId as string, p.n]));

  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    memberCount: t.memberCount,
    projectCount: projectCountByTeam.get(t.id) ?? 0,
    myRole: myRoleByTeam.get(t.id) ?? null,
  }));
}
