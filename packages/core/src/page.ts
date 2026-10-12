import { and, desc, eq, inArray, isNull, isNotNull, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { rankBetween } from "./rank";

export interface CreatePageInput {
  organizationId: string;
  /** Project space. Mutually exclusive with teamId; both null/omitted = the shared Workspace space. */
  projectId?: string | null;
  /** Team space (a team's own docs, not filed under one of its projects). */
  teamId?: string | null;
  /** Private space: the one user who can see it. Callers set it to the actor — RLS rejects anyone else. */
  privateOwnerId?: string | null;
  sprintId?: string | null;
  parentPageId?: string | null;
  title?: string;
  icon?: string;
  type?: "doc" | "template";
  actorUserId: string;
}

/**
 * A page's space — see page.projectId/teamId's doc comment in
 * packages/db/src/schema/page.ts. RLS decides visibility from it, so every
 * page in one subtree must share it: a team-private child under a
 * Workspace parent would be invisible inside a visible tree, and a
 * Workspace child under a team parent would be readable by people who
 * can't see its parent. The same goes for Private: a shared child under a
 * private parent would leak, a private child under a shared parent would
 * vanish for everyone else.
 *
 * `sharedWith` turns a Private tree into a Shared one (people the owner
 * invited). It is part of the space for the same reason: every page of a
 * shared tree must be visible to the same people. Only
 * page-permission.ts's sharing functions change it on an existing tree.
 */
export interface PageSpace {
  projectId: string | null;
  teamId: string | null;
  privateOwnerId: string | null;
  sharedWith: string[];
}

const spaceColumns = {
  projectId: schema.page.projectId,
  teamId: schema.page.teamId,
  privateOwnerId: schema.page.privateOwnerId,
  sharedWith: schema.page.sharedWith,
};

export class PageSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageSpaceError";
  }
}

const sameMembers = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");

function sameSpace(a: PageSpace, b: PageSpace) {
  return a.projectId === b.projectId && a.teamId === b.teamId && a.privateOwnerId === b.privateOwnerId && sameMembers(a.sharedWith, b.sharedWith);
}

/**
 * Resolves the space a new/moved page lands in. With a parent, the parent's
 * space wins, and an explicitly different one is a caller bug, not
 * something to silently override. Without a parent, the requested space
 * (defaulting to Workspace) is used as-is.
 */
async function resolveSpace(tx: Tx, parentPageId: string | null, requested: Partial<PageSpace>): Promise<PageSpace> {
  const projectId = requested.projectId ?? null;
  const teamId = requested.teamId ?? null;
  const privateOwnerId = requested.privateOwnerId ?? null;
  const sharedWith = privateOwnerId ? (requested.sharedWith ?? []) : [];
  if ([projectId, teamId, privateOwnerId].filter(Boolean).length > 1) {
    throw new PageSpaceError("A page belongs to exactly one space: a project, a team, or Private.");
  }
  if (!parentPageId) return { projectId, teamId, privateOwnerId, sharedWith };

  const [parent] = await tx.select(spaceColumns).from(schema.page).where(eq(schema.page.id, parentPageId));
  if (!parent) throw new PageSpaceError(`Parent page ${parentPageId} not found`);

  const explicit = requested.projectId !== undefined || requested.teamId !== undefined || requested.privateOwnerId !== undefined;
  // sharedWith isn't compared: under a parent it's always inherited, so an
  // explicit `private: true` under a Shared parent of the same owner is fine.
  if (explicit && !sameSpace({ ...parent, sharedWith: [] }, { projectId, teamId, privateOwnerId, sharedWith: [] })) {
    throw new PageSpaceError("A child page must be in the same space (workspace, team, project, or private) as its parent.");
  }
  return parent;
}

/** Siblings share the same (space, parentPageId) — a new page always lands last among them. */
async function nextSiblingRank(tx: Tx, space: PageSpace, parentPageId: string | null) {
  const conditions = [
    parentPageId ? eq(schema.page.parentPageId, parentPageId) : isNull(schema.page.parentPageId),
    space.projectId ? eq(schema.page.projectId, space.projectId) : isNull(schema.page.projectId),
    space.teamId ? eq(schema.page.teamId, space.teamId) : isNull(schema.page.teamId),
    space.privateOwnerId ? eq(schema.page.privateOwnerId, space.privateOwnerId) : isNull(schema.page.privateOwnerId),
  ];
  const [last] = await tx
    .select({ rank: schema.page.rank })
    .from(schema.page)
    .where(and(...conditions))
    .orderBy(desc(schema.page.rank))
    .limit(1);
  return rankBetween(last?.rank ?? null, null);
}

export async function createPage(tx: Tx, input: CreatePageInput) {
  const parentPageId = input.parentPageId ?? null;
  const space = await resolveSpace(tx, parentPageId, { projectId: input.projectId, teamId: input.teamId, privateOwnerId: input.privateOwnerId });
  const pageId = id("page");

  await tx.insert(schema.page).values({
    id: pageId,
    organizationId: input.organizationId,
    projectId: space.projectId,
    teamId: space.teamId,
    privateOwnerId: space.privateOwnerId,
    sharedWith: space.sharedWith,
    sprintId: input.sprintId ?? null,
    parentPageId,
    title: input.title ?? "",
    icon: input.icon,
    type: input.type ?? "doc",
    rank: await nextSiblingRank(tx, space, parentPageId),
    createdBy: input.actorUserId,
  });

  const [page] = await tx.select().from(schema.page).where(eq(schema.page.id, pageId));
  return page!;
}

export async function getPage(tx: Tx, pageId: string) {
  const [page] = await tx.select().from(schema.page).where(eq(schema.page.id, pageId));
  if (!page) throw new Error(`Page ${pageId} not found`);
  return page;
}

/** The sprint's linked meeting-minutes doc, if one exists — null if the sprint has none (it was created without an actor, so none was ever created) or it's since been archived. */
export async function getSprintMinutesPage(tx: Tx, sprintId: string) {
  const [page] = await tx
    .select()
    .from(schema.page)
    .where(and(eq(schema.page.sprintId, sprintId), isNull(schema.page.archivedAt)));
  return page ?? null;
}

/**
 * All non-archived pages in a workspace (optionally scoped to one
 * project), flat — the client assembles parentPageId into a tree. A flat
 * list is simpler to keep correct under RLS and cheaper to diff on every
 * sidebar re-render than a recursive query would be.
 */
export async function listPageTree(tx: Tx, organizationId: string, projectId?: string | null) {
  const conditions = [eq(schema.page.organizationId, organizationId), isNull(schema.page.archivedAt)];
  if (projectId !== undefined) {
    conditions.push(projectId ? eq(schema.page.projectId, projectId) : isNull(schema.page.projectId));
  }
  return tx
    .select()
    .from(schema.page)
    .where(and(...conditions))
    .orderBy(schema.page.rank);
}

/** Pages the caller's organization has archived (soft-deleted) — the trash view. */
export async function listArchivedPages(tx: Tx, organizationId: string) {
  return tx
    .select()
    .from(schema.page)
    .where(and(eq(schema.page.organizationId, organizationId), isNotNull(schema.page.archivedAt)))
    .orderBy(desc(schema.page.archivedAt));
}

/** Templates are just pages with type='template' — this is the picker list for "new from template". */
export async function listTemplatePages(tx: Tx, organizationId: string) {
  return tx
    .select()
    .from(schema.page)
    .where(and(eq(schema.page.organizationId, organizationId), eq(schema.page.type, "template"), isNull(schema.page.archivedAt)))
    .orderBy(schema.page.title);
}

/**
 * Hard delete — irreversible, unlike archivePage. Cascades to ydoc_state,
 * page_version, page_comment, page_permission, page_favorite (FK ON DELETE
 * CASCADE) but NOT to child pages, which are re-parented to the trash
 * root instead of being silently deleted with their parent.
 */
export async function permanentlyDeletePage(tx: Tx, pageId: string) {
  await tx.update(schema.page).set({ parentPageId: null }).where(eq(schema.page.parentPageId, pageId));
  await tx.delete(schema.page).where(eq(schema.page.id, pageId));
}

export interface UpdatePageMetaInput {
  title?: string;
  icon?: string | null;
  cover?: string | null;
  type?: "doc" | "template";
}

export async function updatePageMeta(tx: Tx, pageId: string, patch: UpdatePageMetaInput) {
  await tx.update(schema.page).set({ ...patch, updatedAt: new Date() }).where(eq(schema.page.id, pageId));
}

/**
 * Re-parents/re-orders a page. Its space follows the new parent; at the
 * root it is `target.space` if given, otherwise unchanged. A space change
 * carries the whole subtree along, so the tree never straddles two spaces
 * (see PageSpace).
 */
export async function movePage(
  tx: Tx,
  pageId: string,
  target: { parentPageId: string | null; beforeId?: string; afterId?: string; space?: Partial<PageSpace> },
) {
  const page = await getPage(tx, pageId);
  if (target.parentPageId) {
    const descendants = await collectDescendantIds(tx, page.id);
    if (target.parentPageId === page.id || descendants.includes(target.parentPageId)) {
      throw new PageSpaceError("A page can't be moved under itself or one of its own sub-pages.");
    }
  }
  const space = target.parentPageId
    ? await resolveSpace(tx, target.parentPageId, {})
    : await resolveSpace(tx, null, target.space ?? page);
  // A Shared tree's roles live on its root (page-permission.ts). A sub-page
  // pulled out to the top level of the same Shared space becomes a root of
  // its own, so it takes a copy of the old root's grants with it.
  const oldRoot = page.parentPageId && !target.parentPageId && space.sharedWith.length > 0 ? await treeRootId(tx, page.id) : null;

  const [before, after] = await Promise.all([
    target.beforeId ? getPage(tx, target.beforeId) : Promise.resolve(null),
    target.afterId ? getPage(tx, target.afterId) : Promise.resolve(null),
  ]);

  const rank = rankBetween(after?.rank ?? null, before?.rank ?? null);
  await tx
    .update(schema.page)
    .set({ parentPageId: target.parentPageId, rank, ...space, updatedAt: new Date() })
    .where(eq(schema.page.id, page.id));

  if (oldRoot && sameSpace(page, space)) {
    const grants = await tx.select().from(schema.pagePermission).where(eq(schema.pagePermission.pageId, oldRoot));
    if (grants.length > 0) {
      await tx.insert(schema.pagePermission).values(grants.map((g) => ({ ...g, id: id("pageperm"), pageId: page.id }))).onConflictDoNothing();
    }
  }

  if (!sameSpace(page, space)) {
    const descendantIds = await collectDescendantIds(tx, page.id);
    if (descendantIds.length > 0) {
      await tx
        .update(schema.page)
        .set({ ...space, updatedAt: new Date() })
        .where(inArray(schema.page.id, descendantIds));
    }
    const subtree = [page.id, ...descendantIds];
    // Entering or leaving a personal (Private/Shared) space drops the
    // subtree's grants. Coming in, the Shared tree's root decides roles (or
    // there are none, in Private). Going out, Shared invitations must not
    // turn into a restriction that locks out the owner, who never had a
    // grant row of their own.
    if (page.privateOwnerId || space.privateOwnerId) {
      await tx.delete(schema.pagePermission).where(inArray(schema.pagePermission.pageId, subtree));
    }
    // Moving into Private means "only me" (Notion: everyone else loses
    // access). Live guest links would quietly keep it public, so they're
    // revoked too. Publishing it again afterwards is an explicit choice.
    if (space.privateOwnerId && space.sharedWith.length === 0) {
      await tx
        .update(schema.shareLink)
        .set({ revokedAt: new Date() })
        .where(and(inArray(schema.shareLink.pageId, subtree), isNull(schema.shareLink.revokedAt)));
    }
  }
}

/**
 * The top-level page of `pageId`'s tree. A whole tree shares one space
 * (resolveSpace), so every ancestor is visible to anyone who can see the
 * page. Bounded like the breadcrumb walk, against a corrupt cycle.
 */
export async function treeRootId(tx: Tx, pageId: string): Promise<string> {
  let current = pageId;
  for (let depth = 0; depth < 64; depth++) {
    const [row] = await tx.select({ parentPageId: schema.page.parentPageId }).from(schema.page).where(eq(schema.page.id, current));
    if (!row?.parentPageId) return current;
    current = row.parentPageId;
  }
  return current;
}

export async function collectDescendantIds(tx: Tx, pageId: string): Promise<string[]> {
  const children = await tx.select({ id: schema.page.id }).from(schema.page).where(eq(schema.page.parentPageId, pageId));
  const nested = await Promise.all(children.map((c) => collectDescendantIds(tx, c.id)));
  return [...children.map((c) => c.id), ...nested.flat()];
}

/**
 * Cascades to descendants: archiving a page takes its whole subtree with
 * it, the same way deleting a folder does in most file managers — a lone
 * child left behind, not archived, with its parentPageId now pointing at
 * an archived (hidden) page, would silently vanish from the tree (see
 * restorePage's docstring for the same failure mode in reverse).
 */
export async function archivePage(tx: Tx, pageId: string) {
  const descendantIds = await collectDescendantIds(tx, pageId);
  await tx.update(schema.page).set({ archivedAt: new Date() }).where(inArray(schema.page.id, [pageId, ...descendantIds]));
}

/**
 * Restoring re-parents to the workspace root if the original parent is
 * gone or still archived — otherwise a restored page would sit under a
 * still-archived parent and never actually appear in the tree (listPageTree
 * filters out archived pages, so nothing renders the branch that would
 * contain it).
 */
export async function restorePage(tx: Tx, pageId: string) {
  const page = await getPage(tx, pageId);
  let parentPageId = page.parentPageId;
  if (parentPageId) {
    const [parent] = await tx.select().from(schema.page).where(eq(schema.page.id, parentPageId));
    if (!parent || parent.archivedAt) parentPageId = null;
  }
  await tx.update(schema.page).set({ archivedAt: null, parentPageId }).where(eq(schema.page.id, pageId));
}

/**
 * Copies the page row and, if it already has synced content, the current
 * Yjs state — so "use this template" (or plain duplicate) carries content
 * over instead of handing back an empty doc. Does not copy comments,
 * permissions, favorites, or child pages.
 */
export async function duplicatePage(
  tx: Tx,
  pageId: string,
  opts: {
    actorUserId: string;
    projectId?: string | null;
    teamId?: string | null;
    privateOwnerId?: string | null;
    sprintId?: string | null;
    parentPageId?: string | null;
    titleSuffix?: string;
  },
) {
  const source = await getPage(tx, pageId);
  // An explicit target space replaces the source's as a whole — passing
  // only projectId (e.g. a template copied into a project's sprint) must
  // not keep the source's teamId alongside it.
  const retarget = opts.projectId !== undefined || opts.teamId !== undefined || opts.privateOwnerId !== undefined;
  const projectId = retarget ? (opts.projectId ?? null) : source.projectId;
  const teamId = retarget ? (opts.teamId ?? null) : source.teamId;
  // A copy of a Private/Shared page lands in the copier's own Private
  // space: duplicating someone's Shared page must not mint a page that is
  // "owned" by them (RLS would refuse it) or shared with their invitees.
  const privateOwnerId = retarget ? (opts.privateOwnerId ?? null) : source.privateOwnerId ? opts.actorUserId : null;
  const parentPageId = opts.parentPageId !== undefined ? opts.parentPageId : source.parentPageId;

  const created = await createPage(tx, {
    organizationId: source.organizationId,
    // Under a parent, the parent decides the space (resolveSpace); only
    // pass it through for root-level copies so a duplicate-in-place of a
    // nested page doesn't trip the "explicitly different space" check.
    ...(parentPageId ? {} : { projectId, teamId, privateOwnerId }),
    sprintId: opts.sprintId,
    parentPageId,
    title: `${source.title}${opts.titleSuffix ?? ""}`,
    icon: source.icon ?? undefined,
    type: "doc",
    actorUserId: opts.actorUserId,
  });

  const [state] = await tx.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, source.id));
  if (state) {
    await tx.insert(schema.ydocState).values({ pageId: created.id, state: state.state });
  }

  return created;
}
