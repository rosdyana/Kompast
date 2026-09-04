import { and, eq, inArray, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export type PageRole = "view" | "comment" | "edit" | "full";

const ROLE_RANK: Record<PageRole, number> = { view: 0, comment: 1, edit: 2, full: 3 };

/**
 * A page with zero page_permission rows is open to every organization
 * member (the same implicit default P1 already gives projects/boards) —
 * restriction is opt-in. Once any row exists, only listed users/teams may
 * access it at all; there is no fallback to the open default for a
 * restricted page.
 */
export async function canAccessPage(
  tx: Tx,
  pageId: string,
  ctx: { userId: string; organizationId: string },
  minRole: PageRole = "view",
): Promise<boolean> {
  const grants = await tx.select().from(schema.pagePermission).where(eq(schema.pagePermission.pageId, pageId));
  if (grants.length === 0) return true;

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
