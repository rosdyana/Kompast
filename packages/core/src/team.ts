import { and, count, eq, isNotNull, notInArray, schema, sql } from "@kompast/db";
import type { AnyDb, Tx } from "./types";
import { id } from "./ids";

export type TeamMemberRole = "admin" | "member";

/**
 * Kompast-owned team-membership mutations — deliberately NOT
 * auth.api.addTeamMember/removeTeamMember. Those Better Auth endpoints
 * unconditionally check the CALLER's workspace-level member.role against
 * the org+teams plugin's default access statement ("member:update"/"delete"
 * — owner/admin only, no bypass; confirmed by reading
 * node_modules/.../plugins/organization/routes/crud-team.mjs and
 * .../access/statement.mjs directly), which structurally cannot express
 * "this team's own admin, even if their workspace role is plain member" —
 * exactly the case requireTeamAdmin exists to allow. Rather than widen the
 * plugin's global access-control statement (which would also loosen
 * invitation/member endpoints unrelated to team membership) or forge a
 * session, this bypasses the plugin for this one bounded write path — the
 * same workaround apps/web/scripts/seed-dev.ts already used ad hoc for its
 * bootstrap insert, made into the one canonical path instead of a one-off.
 *
 * Because of this, these functions re-implement the plugin's own
 * insert+increment / delete+decrement pairing (better-auth's adapter.mjs
 * findOrCreateTeamMember / removeTeamMember) so team.memberCount stays
 * correct despite the plugin no longer being the one writing it — see that
 * column's own doc comment in packages/db/src/schema/auth.ts.
 */
export async function addTeamMember(
  tx: Tx,
  input: { teamId: string; userId: string; organizationId: string },
): Promise<void> {
  // teamMember.userId is a raw FK to user.id, NOT to member — nothing at the
  // DB level stops adding any user id in the whole installation otherwise.
  // Better Auth's own addTeamMember guards this via adapter.findMemberByOrgId();
  // replicate that check now that we're not calling it.
  const [orgMember] = await tx
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, input.organizationId), eq(schema.member.userId, input.userId)))
    .limit(1);
  if (!orgMember) {
    throw new Error(`User ${input.userId} is not a member of organization ${input.organizationId}`);
  }

  const [existing] = await tx
    .select({ id: schema.teamMember.id })
    .from(schema.teamMember)
    .where(and(eq(schema.teamMember.teamId, input.teamId), eq(schema.teamMember.userId, input.userId)))
    .limit(1);
  if (existing) return; // mirrors the plugin's own findOrCreateTeamMember — already a member is a no-op, not an error

  await tx.insert(schema.teamMember).values({
    id: id("tmem"),
    teamId: input.teamId,
    userId: input.userId,
    // Not Better Auth's private computeTeamMembershipKey (an unexported hash
    // format) — that column is "not app-facing" per its own doc comment, and
    // no Kompast code reads it meaningfully. A plain composite string
    // preserves the one thing its uniqueness index needs: preventing a
    // duplicate (team, user) row under concurrent inserts.
    membershipKey: `${input.teamId}:${input.userId}`,
  });
  await tx
    .update(schema.team)
    .set({ memberCount: sql`${schema.team.memberCount} + 1` })
    .where(eq(schema.team.id, input.teamId));
}

export async function removeTeamMember(tx: Tx, input: { teamId: string; userId: string }): Promise<void> {
  const deleted = await tx
    .delete(schema.teamMember)
    .where(and(eq(schema.teamMember.teamId, input.teamId), eq(schema.teamMember.userId, input.userId)))
    .returning({ id: schema.teamMember.id });
  if (deleted.length === 0) return;
  await tx
    .update(schema.team)
    // Mirrors the plugin's own releaseTeamSeats, which never lets the count go negative.
    .set({ memberCount: sql`greatest(${schema.team.memberCount} - 1, 0)` })
    .where(eq(schema.team.id, input.teamId));
}

export interface TeamMemberView {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: TeamMemberRole;
}

/** This team's current roster, for the team-management page. */
export async function listTeamMembers(db: AnyDb, teamId: string): Promise<TeamMemberView[]> {
  const rows = await db
    .select({
      id: schema.teamMember.id,
      userId: schema.teamMember.userId,
      role: schema.teamMember.role,
      name: schema.user.name,
      email: schema.user.email,
    })
    .from(schema.teamMember)
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMember.userId))
    .where(eq(schema.teamMember.teamId, teamId));
  return rows.map((r) => ({ ...r, role: r.role as TeamMemberRole }));
}

/** Workspace members not yet in this team — the "add member" picker's candidate list. */
export async function listOrgMembersNotInTeam(
  tx: Tx,
  ctx: { organizationId: string },
  teamId: string,
): Promise<{ userId: string; name: string; email: string }[]> {
  const alreadyIn = tx.select({ userId: schema.teamMember.userId }).from(schema.teamMember).where(eq(schema.teamMember.teamId, teamId));
  return tx
    .select({ userId: schema.member.userId, name: schema.user.name, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, ctx.organizationId), notInArray(schema.member.userId, alreadyIn)));
}

/**
 * Updates ONLY team_member.role — the one column Better Auth's org+teams
 * plugin doesn't know about. team_member rows themselves are now created
 * and destroyed exclusively by this file's own addTeamMember/removeTeamMember
 * (above), never by the plugin.
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
