import { and, eq, inArray, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { isSuperAdmin } from "./permissions";

export type PageRole = "view" | "comment" | "edit" | "full";

const ROLE_RANK: Record<PageRole, number> = { view: 0, comment: 1, edit: 2, full: 3 };

/**
 * Per-page restriction, layered on top of team-scoped RLS (which already
 * decides whether the page row is visible at all — a page in another
 * team's space never reaches this function). A page with zero
 * page_permission rows is open to everyone who can see its space;
 * restriction is opt-in. Once any row exists, only listed users/teams may
 * access it — except the workspace super admin, who always can (the same
 * see-everything rule RLS gives them, and what page_permission's own schema
 * comment has always promised).
 */
export async function canAccessPage(
  tx: Tx,
  pageId: string,
  ctx: { userId: string; organizationId: string },
  minRole: PageRole = "view",
): Promise<boolean> {
  // Must come first: for a page RLS hides (another team's space), the
  // grants query below also returns zero rows — which would otherwise read
  // as "unrestricted" and return true for a page the caller can't even see.
  const [visible] = await tx.select({ id: schema.page.id }).from(schema.page).where(eq(schema.page.id, pageId));
  if (!visible) return false;

  const grants = await tx.select().from(schema.pagePermission).where(eq(schema.pagePermission.pageId, pageId));
  if (grants.length === 0) return true;
  if (await isSuperAdmin(tx, ctx)) return true;

  const userGrant = grants.find((g) => g.subjectType === "user" && g.subjectId === ctx.userId);
  if (userGrant && ROLE_RANK[userGrant.role as PageRole] >= ROLE_RANK[minRole]) return true;

  const teamGrants = grants.filter((g) => g.subjectType === "team");
  if (teamGrants.length === 0) return false;

  const memberTeams = await tx
    .select({ teamId: schema.teamMember.teamId })
    .from(schema.teamMember)
    .innerJoin(schema.team, eq(schema.team.id, schema.teamMember.teamId))
    .where(and(eq(schema.team.organizationId, ctx.organizationId), eq(schema.teamMember.userId, ctx.userId)));
  const memberTeamIds = new Set(memberTeams.map((t) => t.teamId));

  return teamGrants.some((g) => memberTeamIds.has(g.subjectId) && ROLE_RANK[g.role as PageRole] >= ROLE_RANK[minRole]);
}

export async function listPagePermissions(tx: Tx, pageId: string) {
  return tx.select().from(schema.pagePermission).where(eq(schema.pagePermission.pageId, pageId));
}

export async function setPagePermission(
  tx: Tx,
  pageId: string,
  subject: { type: "user" | "team"; id: string },
  role: PageRole,
) {
  const [existing] = await tx
    .select({ id: schema.pagePermission.id })
    .from(schema.pagePermission)
    .where(
      and(
        eq(schema.pagePermission.pageId, pageId),
        eq(schema.pagePermission.subjectType, subject.type),
        eq(schema.pagePermission.subjectId, subject.id),
      ),
    );

  if (existing) {
    await tx.update(schema.pagePermission).set({ role }).where(eq(schema.pagePermission.id, existing.id));
    return;
  }

  await tx.insert(schema.pagePermission).values({
    id: id("pageperm"),
    pageId,
    subjectType: subject.type,
    subjectId: subject.id,
    role,
  });
}

export async function removePagePermission(tx: Tx, pageId: string, subject: { type: "user" | "team"; id: string }) {
  await tx
    .delete(schema.pagePermission)
    .where(
      and(
        eq(schema.pagePermission.pageId, pageId),
        eq(schema.pagePermission.subjectType, subject.type),
        eq(schema.pagePermission.subjectId, subject.id),
      ),
    );
}

/** Un-exported check helper reused by filterAccessiblePages — kept here to keep the ROLE_RANK table in one place. */
export async function filterAccessiblePages<T extends { id: string }>(
  tx: Tx,
  pages: T[],
  ctx: { userId: string; organizationId: string },
): Promise<T[]> {
  if (pages.length === 0) return pages;

  const restricted = await tx
    .select({ pageId: schema.pagePermission.pageId })
    .from(schema.pagePermission)
    .where(inArray(schema.pagePermission.pageId, pages.map((p) => p.id)));
  const restrictedIds = new Set(restricted.map((r) => r.pageId));
  if (restrictedIds.size === 0) return pages;

  const accessFlags = await Promise.all(
    pages.map((p) => (restrictedIds.has(p.id) ? canAccessPage(tx, p.id, ctx) : Promise.resolve(true))),
  );
  return pages.filter((_, i) => accessFlags[i]);
}

/** The team whose space a page lives in — directly (team space) or via its project. Null for the Workspace space or a legacy unassigned project. */
async function pageSpaceTeamId(tx: Tx, pageId: string): Promise<string | null> {
  const [row] = await tx
    .select({ teamId: schema.page.teamId, projectTeamId: schema.project.teamId })
    .from(schema.page)
    .leftJoin(schema.project, eq(schema.project.id, schema.page.projectId))
    .where(eq(schema.page.id, pageId));
  return row?.teamId ?? row?.projectTeamId ?? null;
}

/**
 * Who may change a page's access list: anyone with "full" on it (on an
 * unrestricted page that is everyone who can see it — Notion's own
 * default), the admin of the team whose space it's in, or the super admin
 * (via canAccessPage's bypass).
 */
export async function canManagePageAccess(tx: Tx, pageId: string, ctx: { userId: string; organizationId: string }): Promise<boolean> {
  if (await canAccessPage(tx, pageId, ctx, "full")) return true;
  const teamId = await pageSpaceTeamId(tx, pageId);
  if (!teamId) return false;
  const [tm] = await tx
    .select({ role: schema.teamMember.role })
    .from(schema.teamMember)
    .where(and(eq(schema.teamMember.teamId, teamId), eq(schema.teamMember.userId, ctx.userId)));
  return tm?.role === "admin";
}

export interface PageAccessGrant {
  subjectType: "user" | "team";
  subjectId: string;
  name: string;
  detail: string | null;
  role: PageRole;
}

export interface PageAccessView {
  grants: PageAccessGrant[];
  /** People/teams who can see the page's space at all — granting anyone else would be a no-op, since RLS hides the page from them. */
  candidates: { users: { id: string; name: string; email: string }[]; teams: { id: string; name: string }[] };
}

export async function getPageAccess(tx: Tx, pageId: string, ctx: { organizationId: string }): Promise<PageAccessView> {
  const grants = await listPagePermissions(tx, pageId);
  const userIds = grants.filter((g) => g.subjectType === "user").map((g) => g.subjectId);
  const teamIds = grants.filter((g) => g.subjectType === "team").map((g) => g.subjectId);
  const [users, teams] = await Promise.all([
    userIds.length ? tx.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email }).from(schema.user).where(inArray(schema.user.id, userIds)) : [],
    teamIds.length ? tx.select({ id: schema.team.id, name: schema.team.name }).from(schema.team).where(inArray(schema.team.id, teamIds)) : [],
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const teamById = new Map(teams.map((t) => [t.id, t]));

  const spaceTeamId = await pageSpaceTeamId(tx, pageId);
  const candidateUsers = spaceTeamId
    ? await tx
        .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
        .from(schema.teamMember)
        .innerJoin(schema.user, eq(schema.user.id, schema.teamMember.userId))
        .where(eq(schema.teamMember.teamId, spaceTeamId))
    : await tx
        .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
        .from(schema.member)
        .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
        .where(eq(schema.member.organizationId, ctx.organizationId));
  // A team-space page is only visible to that one team, so offering other
  // teams (or the team itself, which already sees it) would be meaningless.
  const candidateTeams = spaceTeamId
    ? []
    : await tx.select({ id: schema.team.id, name: schema.team.name }).from(schema.team).where(eq(schema.team.organizationId, ctx.organizationId));

  return {
    grants: grants.map((g) => {
      const u = g.subjectType === "user" ? userById.get(g.subjectId) : undefined;
      const t = g.subjectType === "team" ? teamById.get(g.subjectId) : undefined;
      return {
        subjectType: g.subjectType as "user" | "team",
        subjectId: g.subjectId,
        name: u?.name ?? t?.name ?? g.subjectId,
        detail: u?.email ?? null,
        role: g.role as PageRole,
      };
    }),
    candidates: { users: candidateUsers, teams: candidateTeams },
  };
}

/**
 * Adds/updates one grant. The first grant turns an open page into a
 * restricted one, which would immediately lock out the person restricting
 * it unless they're listed too — so the actor is granted "full" alongside
 * the very first restriction.
 */
export async function grantPageAccess(
  tx: Tx,
  input: { pageId: string; subject: { type: "user" | "team"; id: string }; role: PageRole; actorUserId: string },
): Promise<void> {
  const existing = await listPagePermissions(tx, input.pageId);
  if (existing.length === 0 && !(input.subject.type === "user" && input.subject.id === input.actorUserId)) {
    await setPagePermission(tx, input.pageId, { type: "user", id: input.actorUserId }, "full");
  }
  await setPagePermission(tx, input.pageId, input.subject, input.role);
}
