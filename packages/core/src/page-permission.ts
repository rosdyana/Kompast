import { and, eq, inArray, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { isSuperAdmin } from "./permissions";
import { collectDescendantIds, PageSpaceError, treeRootId } from "./page";
import { notify } from "./notification";

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
  const [visible] = await tx
    .select({ id: schema.page.id, privateOwnerId: schema.page.privateOwnerId, sharedWith: schema.page.sharedWith })
    .from(schema.page)
    .where(eq(schema.page.id, pageId));
  if (!visible) return false;
  if (visible.privateOwnerId) return ROLE_RANK[await personalPageRole(tx, visible as PersonalPage, ctx)] >= ROLE_RANK[minRole];

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

type PersonalPage = { id: string; privateOwnerId: string; sharedWith: string[] };

/**
 * Role on a Private/Shared page the caller can already see (RLS let it
 * through). The owner has full access. An invitee has their grant on the
 * tree's root: sharing is per tree, like Notion's sub-pages inheriting
 * their parent's permissions. The only other way RLS lets someone see it is
 * the super admin recovering a departed member's page, which needs full
 * access to move it.
 */
async function personalPageRole(tx: Tx, page: PersonalPage, ctx: { userId: string }): Promise<PageRole> {
  if (page.privateOwnerId === ctx.userId) return "full";
  if (page.sharedWith.includes(ctx.userId)) {
    const [grant] = await tx
      .select({ role: schema.pagePermission.role })
      .from(schema.pagePermission)
      .where(
        and(
          eq(schema.pagePermission.pageId, await treeRootId(tx, page.id)),
          eq(schema.pagePermission.subjectType, "user"),
          eq(schema.pagePermission.subjectId, ctx.userId),
        ),
      );
    return (grant?.role as PageRole | undefined) ?? "view";
  }
  return "full";
}

/**
 * Re-derives a personal tree's `shared_with` from its root's user grants
 * and writes it onto every page of the tree. Zero grants turns a Shared
 * tree back into a Private one, like un-inviting everyone in Notion.
 */
async function syncSharedWith(tx: Tx, rootId: string): Promise<string[]> {
  const grants = await tx
    .select({ subjectId: schema.pagePermission.subjectId })
    .from(schema.pagePermission)
    .where(and(eq(schema.pagePermission.pageId, rootId), eq(schema.pagePermission.subjectType, "user")));
  const sharedWith = [...new Set(grants.map((g) => g.subjectId))].sort();
  const tree = [rootId, ...(await collectDescendantIds(tx, rootId))];
  await tx.update(schema.page).set({ sharedWith, updatedAt: new Date() }).where(inArray(schema.page.id, tree));
  return sharedWith;
}

async function personalPage(tx: Tx, pageId: string) {
  const [page] = await tx
    .select({ id: schema.page.id, organizationId: schema.page.organizationId, title: schema.page.title, privateOwnerId: schema.page.privateOwnerId })
    .from(schema.page)
    .where(eq(schema.page.id, pageId));
  return page?.privateOwnerId ? page : null;
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

export async function removePagePermission(
  tx: Tx,
  pageId: string,
  subject: { type: "user" | "team"; id: string },
  actorUserId?: string,
) {
  const personal = await personalPage(tx, pageId);
  if (personal) {
    // Under RLS an UPDATE can't leave the updater unable to see the row
    // (USING doubles as WITH CHECK), so removing yourself from shared_with
    // fails at the database. Say so plainly instead.
    if (subject.type === "user" && subject.id === actorUserId) {
      throw new PageSpaceError("You can't remove yourself from a shared page. Ask its owner to remove you.");
    }
    const rootId = await treeRootId(tx, pageId);
    await tx
      .delete(schema.pagePermission)
      .where(
        and(
          eq(schema.pagePermission.pageId, rootId),
          eq(schema.pagePermission.subjectType, subject.type),
          eq(schema.pagePermission.subjectId, subject.id),
        ),
      );
    await syncSharedWith(tx, rootId);
    return;
  }
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
  /**
   * Set for a Private/Shared page: its owner, who always has full access and
   * never appears in `grants`. Grants then list the people it's shared with
   * (the tree root's, see personalPageRole); teams can't be invited.
   */
  owner: { id: string; name: string } | null;
}

async function getPersonalPageAccess(tx: Tx, ownerId: string, rootId: string, ctx: { organizationId: string }): Promise<PageAccessView> {
  const grants = (await listPagePermissions(tx, rootId)).filter((g) => g.subjectType === "user");
  const people = await tx
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(eq(schema.member.organizationId, ctx.organizationId));
  const byId = new Map(people.map((u) => [u.id, u]));
  const [owner] = await tx.select({ id: schema.user.id, name: schema.user.name }).from(schema.user).where(eq(schema.user.id, ownerId));
  return {
    grants: grants.map((g) => ({
      subjectType: "user" as const,
      subjectId: g.subjectId,
      name: byId.get(g.subjectId)?.name ?? g.subjectId,
      detail: byId.get(g.subjectId)?.email ?? null,
      role: g.role as PageRole,
    })),
    candidates: { users: people.filter((u) => u.id !== ownerId), teams: [] },
    owner: owner ?? { id: ownerId, name: ownerId },
  };
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

  const personal = await personalPage(tx, pageId);
  if (personal) return getPersonalPageAccess(tx, personal.privateOwnerId!, await treeRootId(tx, pageId), ctx);

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
    owner: null,
  };
}

/**
 * Inviting someone to a Private page makes it Shared (Notion moves it to
 * the "Shared" sidebar section). The grant goes on the tree's root and
 * shared_with is re-synced across the tree, so sub-pages follow.
 */
async function sharePersonalPage(
  tx: Tx,
  page: { id: string; organizationId: string; title: string; privateOwnerId: string | null },
  input: { subject: { type: "user" | "team"; id: string }; role: PageRole; actorUserId: string },
) {
  if (input.subject.type !== "user") throw new PageSpaceError("A private page is shared with people, not teams. Move it to a team space to share it with a team.");
  if (input.subject.id === page.privateOwnerId) throw new PageSpaceError("The owner already has full access to their own page.");
  const [membership] = await tx
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, page.organizationId), eq(schema.member.userId, input.subject.id)));
  if (!membership) throw new PageSpaceError("Only members of this workspace can be invited to a page.");

  const rootId = await treeRootId(tx, page.id);
  const [root] = await tx.select({ sharedWith: schema.page.sharedWith, title: schema.page.title }).from(schema.page).where(eq(schema.page.id, rootId));
  const isNew = !root!.sharedWith.includes(input.subject.id);
  await setPagePermission(tx, rootId, input.subject, input.role);
  await syncSharedWith(tx, rootId);
  if (isNew) {
    const [actor] = await tx.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, input.actorUserId));
    const actorName = actor?.name ?? "Someone";
    // After the sync, so notify()'s visibility re-check sees the invitee.
    await notify(tx, {
      organizationId: page.organizationId,
      userId: input.subject.id,
      eventType: "page.shared",
      entityType: "page",
      entityId: rootId,
      title: `${actorName} shared "${root!.title || "Untitled"}" with you`,
    });
  }
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
  const personal = await personalPage(tx, input.pageId);
  if (personal) return sharePersonalPage(tx, personal, input);
  const existing = await listPagePermissions(tx, input.pageId);
  if (existing.length === 0 && !(input.subject.type === "user" && input.subject.id === input.actorUserId)) {
    await setPagePermission(tx, input.pageId, { type: "user", id: input.actorUserId }, "full");
  }
  await setPagePermission(tx, input.pageId, input.subject, input.role);
}
