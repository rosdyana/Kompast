import { and, eq, inArray, isNotNull, notInArray, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { requireSuperAdmin, type AuthContext } from "./permissions";
import { collectDescendantIds, movePage, PageSpaceError } from "./page";

/**
 * Private/Shared pages whose owner has left the workspace. Nobody can open
 * a Private page but its owner, so without this path a departed person's
 * notes would be stuck forever (Notion only offers the equivalent as an
 * Enterprise admin feature). RLS (rls.sql, page policy) lets the super
 * admin, and only them, see exactly these pages: a private page whose
 * owner is no longer a member. A current member's private pages stay
 * invisible to them, so this can't be used to read anyone's notes while
 * they're still here.
 */
export interface DepartedMemberPageTree {
  rootId: string;
  title: string;
  icon: string | null;
  archived: boolean;
  owner: { id: string; name: string; email: string };
  /** Pages in the tree, root included. */
  pageCount: number;
  /** People it was shared with (a Shared tree). They still have their access until it is recovered. */
  sharedWithCount: number;
}

async function departedOwnerPages(tx: Tx, organizationId: string, actorUserId: string) {
  const members = tx.select({ userId: schema.member.userId }).from(schema.member).where(eq(schema.member.organizationId, organizationId));
  // The NOT IN repeats RLS's own condition on purpose: RLS also lets the
  // super admin see private pages shared with them by a current member,
  // and those aren't orphaned.
  return tx
    .select({
      id: schema.page.id,
      parentPageId: schema.page.parentPageId,
      title: schema.page.title,
      icon: schema.page.icon,
      archivedAt: schema.page.archivedAt,
      privateOwnerId: schema.page.privateOwnerId,
      sharedWith: schema.page.sharedWith,
    })
    .from(schema.page)
    .where(
      and(
        eq(schema.page.organizationId, organizationId),
        isNotNull(schema.page.privateOwnerId),
        notInArray(schema.page.privateOwnerId, members),
        // Defensive: the actor is a member (withAuthorizedTenant checked), so never their own.
        notInArray(schema.page.privateOwnerId, [actorUserId]),
      ),
    );
}

export async function listDepartedMemberPages(tx: Tx, ctx: AuthContext): Promise<DepartedMemberPageTree[]> {
  await requireSuperAdmin(tx, ctx);
  const pages = await departedOwnerPages(tx, ctx.organizationId, ctx.userId);
  if (pages.length === 0) return [];

  const ids = new Set(pages.map((p) => p.id));
  const children = new Map<string, string[]>();
  for (const p of pages) {
    if (p.parentPageId && ids.has(p.parentPageId)) children.set(p.parentPageId, [...(children.get(p.parentPageId) ?? []), p.id]);
  }
  const size = (pageId: string): number => 1 + (children.get(pageId) ?? []).reduce((n, c) => n + size(c), 0);

  const roots = pages.filter((p) => !p.parentPageId || !ids.has(p.parentPageId));
  const ownerIds = [...new Set(roots.map((r) => r.privateOwnerId!))];
  const owners = await tx.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email }).from(schema.user).where(inArray(schema.user.id, ownerIds));
  const ownerById = new Map(owners.map((o) => [o.id, o]));

  return roots
    .map((r) => ({
      rootId: r.id,
      title: r.title,
      icon: r.icon,
      archived: r.archivedAt !== null,
      owner: ownerById.get(r.privateOwnerId!) ?? { id: r.privateOwnerId!, name: r.privateOwnerId!, email: "" },
      pageCount: size(r.id),
      sharedWithCount: r.sharedWith.length,
    }))
    .sort((a, b) => a.owner.name.localeCompare(b.owner.name) || a.title.localeCompare(b.title));
}

/**
 * Recovers one departed member's page tree:
 * - "me": the super admin becomes its owner. It lands in their Private
 *   space, or stays Shared with the same people if it was shared.
 * - "workspace": moved to the shared Workspace space for everyone (invites
 *   dropped, the same as any move out of a personal space).
 * Recorded in audit_log, since it's an admin reaching into someone's
 * private notes.
 */
export async function recoverDepartedMemberPage(tx: Tx, ctx: AuthContext, input: { pageId: string; to: "me" | "workspace" }): Promise<void> {
  await requireSuperAdmin(tx, ctx);
  const pages = await departedOwnerPages(tx, ctx.organizationId, ctx.userId);
  const root = pages.find((p) => p.id === input.pageId);
  if (!root) throw new PageSpaceError("That page isn't a departed member's private page.");
  if (root.parentPageId && pages.some((p) => p.id === root.parentPageId)) {
    throw new PageSpaceError("Recover the top-level page; its sub-pages come with it.");
  }

  const tree = [root.id, ...(await collectDescendantIds(tx, root.id))];
  if (input.to === "me") {
    // The new owner can't also be an invitee of their own page.
    const sharedWith = root.sharedWith.filter((u) => u !== ctx.userId);
    await tx.update(schema.page).set({ privateOwnerId: ctx.userId, sharedWith, updatedAt: new Date() }).where(inArray(schema.page.id, tree));
    await tx
      .delete(schema.pagePermission)
      .where(and(eq(schema.pagePermission.pageId, root.id), eq(schema.pagePermission.subjectType, "user"), eq(schema.pagePermission.subjectId, ctx.userId)));
  } else {
    await movePage(tx, root.id, { parentPageId: null, space: {} });
  }

  await tx.insert(schema.auditLog).values({
    id: id("audit"),
    organizationId: ctx.organizationId,
    actorId: ctx.userId,
    origin: "user",
    action: input.to === "me" ? "page.recovered_to_self" : "page.recovered_to_workspace",
    entityType: "page",
    entityId: root.id,
    metadata: JSON.stringify({ previousOwnerId: root.privateOwnerId, pageCount: tree.length, sharedWith: root.sharedWith }),
  });
}
