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
  /** Null for a locked team — counts of a team you can't see aren't yours to know either. */
  memberCount: number | null;
  projectCount: number | null;
  /** This viewer's own team_member.role, or null if they aren't a member of this team at all. */
  myRole: TeamMemberRole | null;
  /**
   * True when the viewer is neither a member nor the super admin: the
   * sidebar shows the team's name (D4 in the team-visibility spec) but
   * none of its content, which RLS hides anyway.
   */
  locked: boolean;
  /** Who to ask for access — shown on a locked team's row. */
  adminNames: string[];
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
 *
 * Every team in the workspace is listed (locked ones included) because
 * team/team_member have no RLS; `locked` is computed here, not by the DB.
 */
export async function listTeamsForWorkspace(
  tx: Tx,
  ctx: { organizationId: string; userId: string },
): Promise<TeamSummary[]> {
  const teams = await tx
    .select({ id: schema.team.id, name: schema.team.name, memberCount: schema.team.memberCount })
    .from(schema.team)
    .where(eq(schema.team.organizationId, ctx.organizationId))
    .orderBy(schema.team.name);

  const [me] = await tx
    .select({ isSuperAdmin: schema.member.isSuperAdmin })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId)));
  const viewerIsSuperAdmin = me?.isSuperAdmin ?? false;

  const myMemberships = await tx
    .select({ teamId: schema.teamMember.teamId, role: schema.teamMember.role })
    .from(schema.teamMember)
    .innerJoin(schema.team, eq(schema.team.id, schema.teamMember.teamId))
    .where(and(eq(schema.team.organizationId, ctx.organizationId), eq(schema.teamMember.userId, ctx.userId)));
  const myRoleByTeam = new Map(myMemberships.map((m) => [m.teamId, m.role as TeamMemberRole]));

  const admins = await tx
    .select({ teamId: schema.teamMember.teamId, name: schema.user.name })
    .from(schema.teamMember)
    .innerJoin(schema.team, eq(schema.team.id, schema.teamMember.teamId))
    .innerJoin(schema.user, eq(schema.user.id, schema.teamMember.userId))
    .where(and(eq(schema.team.organizationId, ctx.organizationId), eq(schema.teamMember.role, "admin")));
  const adminNamesByTeam = new Map<string, string[]>();
  for (const a of admins) adminNamesByTeam.set(a.teamId, [...(adminNamesByTeam.get(a.teamId) ?? []), a.name]);

  // RLS-scoped: counts only projects the viewer can see — exactly the set
  // a locked team's count would otherwise leak.
  const projectCounts = await tx
    .select({ teamId: schema.project.teamId, n: count() })
    .from(schema.project)
    .where(and(eq(schema.project.organizationId, ctx.organizationId), isNotNull(schema.project.teamId)))
    .groupBy(schema.project.teamId);
  const projectCountByTeam = new Map(projectCounts.map((p) => [p.teamId as string, p.n]));

  return teams.map((t) => {
    const myRole = myRoleByTeam.get(t.id) ?? null;
    const locked = !viewerIsSuperAdmin && myRole === null;
    return {
      id: t.id,
      name: t.name,
      memberCount: locked ? null : t.memberCount,
      projectCount: locked ? null : (projectCountByTeam.get(t.id) ?? 0),
      myRole,
      locked,
      adminNames: adminNamesByTeam.get(t.id) ?? [],
    };
  });
}

/** Better Auth's own default (organization plugin's invitationExpiresIn). */
const TEAM_INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

export class TeamInvitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamInvitationError";
  }
}

/**
 * A team admin inviting someone new into their team (and, as a consequence,
 * into the workspace as a plain `member` — M3 in the team-visibility spec:
 * a team admin must never be able to mint a workspace admin).
 *
 * Writes Better Auth's `invitation` row directly rather than calling
 * auth.api.createInvitation, for the same reason addTeamMember above
 * bypasses the plugin: its endpoint checks the CALLER's workspace-level
 * member.role for "invitation:create" (owner/admin only), which can't
 * express "this team's own admin". Caller must have passed requireTeamAdmin.
 * Accepting still goes through the plugin's real acceptInvitation (email
 * match, status/expiry checks, member + team_member creation) — only
 * creation is ours. `team_role` is Kompast's own column; see
 * applyAcceptedTeamInvitation for where it takes effect.
 *
 * Someone already in the workspace isn't invited — the team admin adds
 * them from the workspace-member list instead (accepting would otherwise
 * try to create a duplicate member row). Re-inviting a pending address is
 * a no-op returning the existing invitation, so the email isn't re-sent
 * by a double-click.
 */
export async function createTeamInvitation(
  tx: Tx,
  input: { organizationId: string; teamId: string; email: string; teamRole: TeamMemberRole; inviterId: string },
): Promise<{ id: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();

  const [existingMember] = await tx
    .select({ id: schema.member.id })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, input.organizationId), sql`lower(${schema.user.email}) = ${email}`))
    .limit(1);
  if (existingMember) {
    throw new TeamInvitationError(`${email} is already in this workspace — add them to the team from the member list instead.`);
  }

  const [pending] = await tx
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.organizationId, input.organizationId),
        eq(schema.invitation.teamId, input.teamId),
        eq(schema.invitation.status, "pending"),
        sql`lower(${schema.invitation.email}) = ${email}`,
        sql`${schema.invitation.expiresAt} > now()`,
      ),
    )
    .limit(1);
  if (pending) return { id: pending.id, created: false };

  const invitationId = id("inv");
  await tx.insert(schema.invitation).values({
    id: invitationId,
    organizationId: input.organizationId,
    email,
    role: "member",
    teamId: input.teamId,
    teamRole: input.teamRole,
    status: "pending",
    expiresAt: new Date(Date.now() + TEAM_INVITATION_TTL_MS),
    inviterId: input.inviterId,
  });
  return { id: invitationId, created: true };
}

export interface TeamInvitationView {
  id: string;
  email: string;
  teamRole: TeamMemberRole;
  expiresAt: Date;
}

/** Pending, unexpired invitations into this team — the team-management page's "Pending" list. */
export async function listTeamInvitations(db: AnyDb, teamId: string): Promise<TeamInvitationView[]> {
  const rows = await db
    .select({ id: schema.invitation.id, email: schema.invitation.email, teamRole: schema.invitation.teamRole, expiresAt: schema.invitation.expiresAt })
    .from(schema.invitation)
    .where(and(eq(schema.invitation.teamId, teamId), eq(schema.invitation.status, "pending"), sql`${schema.invitation.expiresAt} > now()`))
    .orderBy(schema.invitation.createdAt);
  return rows.map((r) => ({ ...r, teamRole: (r.teamRole ?? "member") as TeamMemberRole }));
}

/** Scoped by teamId so a team admin can only cancel their own team's invitations. */
export async function cancelTeamInvitation(db: AnyDb, input: { teamId: string; invitationId: string }): Promise<void> {
  await db
    .update(schema.invitation)
    .set({ status: "canceled" })
    .where(and(eq(schema.invitation.id, input.invitationId), eq(schema.invitation.teamId, input.teamId), eq(schema.invitation.status, "pending")));
}

/**
 * Runs right after Better Auth's acceptInvitation succeeds. The plugin has
 * already created the member row and (for a team invitation) the
 * team_member row via its own findOrCreateTeamMember; this only makes the
 * team membership exist for certain (addTeamMember is idempotent — a
 * no-op when the plugin already did it) and applies the team role the
 * invitation was issued with, which the plugin knows nothing about.
 * Workspace-level invitations (no teamId) are left untouched.
 */
export async function applyAcceptedTeamInvitation(tx: Tx, input: { invitationId: string; userId: string }): Promise<void> {
  const [invitation] = await tx
    .select({ organizationId: schema.invitation.organizationId, teamId: schema.invitation.teamId, teamRole: schema.invitation.teamRole, status: schema.invitation.status })
    .from(schema.invitation)
    .where(eq(schema.invitation.id, input.invitationId));
  if (!invitation?.teamId || invitation.status !== "accepted") return;

  await addTeamMember(tx, { teamId: invitation.teamId, userId: input.userId, organizationId: invitation.organizationId });
  if (invitation.teamRole === "admin") {
    await setTeamMemberRole(tx, { teamId: invitation.teamId, userId: input.userId, role: "admin" });
  }
}

/**
 * Who an issue in `projectId` can be assigned to / @mentioned in (M4 in the
 * team-visibility spec): the owning team's members plus the super admin —
 * the same people RLS lets open the issue. Offering the whole workspace
 * would let work be assigned to someone who then can't see it.
 */
export async function listAssignableUsers(
  tx: Tx,
  input: { organizationId: string; projectId: string },
): Promise<{ userId: string; name: string; email: string }[]> {
  const [project] = await tx.select({ teamId: schema.project.teamId }).from(schema.project).where(eq(schema.project.id, input.projectId));
  const teamMembers = project?.teamId
    ? await tx
        .select({ userId: schema.user.id, name: schema.user.name, email: schema.user.email })
        .from(schema.teamMember)
        .innerJoin(schema.user, eq(schema.user.id, schema.teamMember.userId))
        .where(eq(schema.teamMember.teamId, project.teamId))
    : [];
  const superAdmins = await tx
    .select({ userId: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(and(eq(schema.member.organizationId, input.organizationId), eq(schema.member.isSuperAdmin, true)));
  const byId = new Map([...teamMembers, ...superAdmins].map((u) => [u.userId, u]));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

