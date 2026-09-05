import { and, eq, schema, withTenant, db as defaultDb } from "@kompast/db";
import type { AnyDb, Tx } from "./types";

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface AuthContext {
  userId: string;
  organizationId: string;
}

/**
 * Verifies the user is actually a member of the organization before any
 * query runs. This is NOT redundant with RLS: RLS only checks that a row's
 * organization_id matches whatever `app.current_workspace` happens to be
 * set to — it has no idea whether the connecting user is entitled to *that*
 * workspace at all. If a caller derived organizationId from unchecked input
 * (a URL param, a client-supplied field) rather than from this check, RLS
 * would happily scope the query to a workspace the user was never a member
 * of. This function, not RLS, is what makes organizationId trustworthy.
 */
export async function requireMembership(
  db: AnyDb,
  ctx: AuthContext,
): Promise<{ role: string }> {
  const [row] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, ctx.organizationId),
        eq(schema.member.userId, ctx.userId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ForbiddenError(`User ${ctx.userId} is not a member of organization ${ctx.organizationId}`);
  }
  return row;
}

/**
 * The actual "single enforcement point" callers should use: verifies
 * membership, then runs `fn` inside a withTenant() transaction scoped to
 * that (now-trusted) organizationId. Every mutation and every non-trivial
 * read in packages/core goes through this, never through `db` or
 * `withTenant` directly — see plan §Architecture, "Tenant isolation".
 */
export async function withAuthorizedTenant<T>(ctx: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireMembership(defaultDb, ctx);
  return withTenant(defaultDb, { organizationId: ctx.organizationId, userId: ctx.userId }, fn);
}

export async function requireProjectAccess(
  db: AnyDb,
  ctx: AuthContext & { projectId: string },
): Promise<void> {
  const [row] = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(and(eq(schema.project.id, ctx.projectId), eq(schema.project.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) {
    throw new ForbiddenError(`Project ${ctx.projectId} not found in organization ${ctx.organizationId}`);
  }
}

/**
 * Whether ctx.userId holds the workspace's single super-admin flag.
 * Distinct from requireSystemAdmin (settings.ts) — that gate is for
 * /settings and treats "owner"/"admin" as equivalent; this one is
 * specifically for team creation and super-admin transfer, and there is
 * never more than one true holder per organization (member_org_super_
 * admin_uq, packages/db/src/schema/auth.ts).
 */
export async function requireSuperAdmin(db: AnyDb, ctx: AuthContext): Promise<void> {
  const [row] = await db
    .select({ isSuperAdmin: schema.member.isSuperAdmin })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId)))
    .limit(1);
  if (!row?.isSuperAdmin) {
    throw new ForbiddenError(`User ${ctx.userId} is not the super admin of organization ${ctx.organizationId}`);
  }
}

/**
 * Whether ctx.userId can create a project in ctx.teamId: either they are
 * this team's own admin (team_member.role === "admin"), or they are the
 * workspace's super admin, who is treated as an implicit admin of every
 * team rather than needing a separate team_member row per team. Confirms
 * teamId actually belongs to ctx.organizationId first — never trust a
 * client-supplied teamId any more than requireProjectAccess trusts a
 * client-supplied projectId.
 */
export async function requireTeamAdmin(
  db: AnyDb,
  ctx: AuthContext & { teamId: string },
): Promise<void> {
  const [team] = await db
    .select({ id: schema.team.id })
    .from(schema.team)
    .where(and(eq(schema.team.id, ctx.teamId), eq(schema.team.organizationId, ctx.organizationId)))
    .limit(1);
  if (!team) {
    throw new ForbiddenError(`Team ${ctx.teamId} not found in organization ${ctx.organizationId}`);
  }

  const [member] = await db
    .select({ isSuperAdmin: schema.member.isSuperAdmin })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId)))
    .limit(1);
  if (member?.isSuperAdmin) return;

  const [teamMember] = await db
    .select({ role: schema.teamMember.role })
    .from(schema.teamMember)
    .where(and(eq(schema.teamMember.teamId, ctx.teamId), eq(schema.teamMember.userId, ctx.userId)))
    .limit(1);
  if (!teamMember || teamMember.role !== "admin") {
    throw new ForbiddenError(`User ${ctx.userId} is not an admin of team ${ctx.teamId}`);
  }
}

/**
 * Whether ctx.userId can manage ctx.projectId's settings (kanban columns,
 * custom ticket properties): the workspace super admin, the admin of the
 * project's owning team, or a project_member row with role "lead" for
 * this specific project.
 *
 * MUST be called with an already-open Tx (from inside
 * withAuthorizedTenant's callback), unlike requireTeamAdmin/
 * requireSuperAdmin above, which read team/team_member/member — none of
 * which have RLS (see packages/db/rls.sql). This function reads `project`,
 * which IS RLS-force-enabled, so a query against plain `db` before opening
 * a tx would deterministically see zero rows and reject every caller, not
 * just unauthorized ones. Don't "fix" this to match requireTeamAdmin's
 * calling convention — the two are asymmetric on purpose.
 */
export async function requireProjectAdmin(
  db: AnyDb,
  ctx: AuthContext & { projectId: string },
): Promise<void> {
  const [project] = await db
    .select({ id: schema.project.id, teamId: schema.project.teamId })
    .from(schema.project)
    .where(and(eq(schema.project.id, ctx.projectId), eq(schema.project.organizationId, ctx.organizationId)))
    .limit(1);
  if (!project) throw new ForbiddenError(`Project ${ctx.projectId} not found in organization ${ctx.organizationId}`);

  const [member] = await db
    .select({ isSuperAdmin: schema.member.isSuperAdmin })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, ctx.userId)))
    .limit(1);
  if (member?.isSuperAdmin) return;

  if (project.teamId) {
    const [teamMember] = await db
      .select({ role: schema.teamMember.role })
      .from(schema.teamMember)
      .where(and(eq(schema.teamMember.teamId, project.teamId), eq(schema.teamMember.userId, ctx.userId)))
      .limit(1);
    if (teamMember?.role === "admin") return;
  }

  const [projectMember] = await db
    .select({ role: schema.projectMember.role })
    .from(schema.projectMember)
    .where(and(eq(schema.projectMember.projectId, ctx.projectId), eq(schema.projectMember.userId, ctx.userId)))
    .limit(1);
  if (projectMember?.role === "lead") return;

  throw new ForbiddenError(`User ${ctx.userId} cannot manage project ${ctx.projectId}`);
}

/**
 * Atomic super-admin handoff: unsets the current holder, sets the new one,
 * inside one tx (member_org_super_admin_uq is checked per-statement, not
 * deferred — hence two sequential UPDATEs, never one that could momentarily
 * hold two true rows). Only the CURRENT super admin may call this
 * (requireSuperAdmin re-checked here even though callers are expected to
 * have already checked it — same belt-and-suspenders posture as
 * requireProjectAccess).
 *
 * Also promotes the new holder's member.role to "admin" if it's currently
 * plain "member" — NOT optional bookkeeping. `createTeamFn`
 * (apps/web/src/lib/server-fns/teams.ts) still calls Better Auth's real
 * `auth.api.createTeam` with a real session's headers (team-membership
 * mutations were moved off the plugin entirely — see packages/core/src/
 * team.ts's addTeamMember/removeTeamMember — but team *creation* itself
 * still goes through the plugin), which hard-requires the caller's own
 * member.role to grant "team:create" per its default access-control
 * statement (owner/admin: yes, member: no). Without this invariant, a
 * super admin who was a plain member before the transfer would pass OUR
 * OWN requireSuperAdmin gate but still get rejected by Better Auth's own
 * plugin the moment they tried to create a team.
 */
export async function transferSuperAdmin(
  tx: Tx,
  ctx: AuthContext,
  newHolderUserId: string,
): Promise<void> {
  await requireSuperAdmin(tx, ctx);

  await tx
    .update(schema.member)
    .set({ isSuperAdmin: false })
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.isSuperAdmin, true)));

  const updated = await tx
    .update(schema.member)
    .set({ isSuperAdmin: true })
    .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, newHolderUserId)))
    .returning({ role: schema.member.role });
  if (updated.length === 0) {
    throw new Error(`User ${newHolderUserId} is not a member of organization ${ctx.organizationId}`);
  }

  if (updated[0]!.role === "member") {
    await tx
      .update(schema.member)
      .set({ role: "admin" })
      .where(and(eq(schema.member.organizationId, ctx.organizationId), eq(schema.member.userId, newHolderUserId)));
  }
}
