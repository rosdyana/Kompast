import { and, desc, eq, isNull, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { rankBetween } from "./rank";

export interface CreatePageInput {
  organizationId: string;
  projectId?: string | null;
  parentPageId?: string | null;
  title?: string;
  icon?: string;
  type?: "doc" | "template";
  actorUserId: string;
}

/** Siblings share the same (projectId, parentPageId) pair — a new page always lands last among them. */
async function nextSiblingRank(tx: Tx, projectId: string | null, parentPageId: string | null) {
  const conditions = [
    parentPageId ? eq(schema.page.parentPageId, parentPageId) : isNull(schema.page.parentPageId),
    projectId ? eq(schema.page.projectId, projectId) : isNull(schema.page.projectId),
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
  const projectId = input.projectId ?? null;
  const parentPageId = input.parentPageId ?? null;
  const pageId = id("page");

  await tx.insert(schema.page).values({
    id: pageId,
    organizationId: input.organizationId,
    projectId,
    parentPageId,
    title: input.title ?? "",
    icon: input.icon,
    type: input.type ?? "doc",
    rank: await nextSiblingRank(tx, projectId, parentPageId),
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

export interface UpdatePageMetaInput {
  title?: string;
  icon?: string | null;
  cover?: string | null;
}

export async function updatePageMeta(tx: Tx, pageId: string, patch: UpdatePageMetaInput) {
  await tx.update(schema.page).set({ ...patch, updatedAt: new Date() }).where(eq(schema.page.id, pageId));
}

export async function movePage(
  tx: Tx,
  pageId: string,
  target: { parentPageId: string | null; beforeId?: string; afterId?: string },
) {
  const page = await getPage(tx, pageId);

  const [before, after] = await Promise.all([
    target.beforeId ? getPage(tx, target.beforeId) : Promise.resolve(null),
    target.afterId ? getPage(tx, target.afterId) : Promise.resolve(null),
  ]);

  const rank = rankBetween(after?.rank ?? null, before?.rank ?? null);
  await tx
    .update(schema.page)
    .set({ parentPageId: target.parentPageId, rank, updatedAt: new Date() })
    .where(eq(schema.page.id, page.id));
}

export async function archivePage(tx: Tx, pageId: string) {
  await tx.update(schema.page).set({ archivedAt: new Date() }).where(eq(schema.page.id, pageId));
}

export async function restorePage(tx: Tx, pageId: string) {
  await tx.update(schema.page).set({ archivedAt: null }).where(eq(schema.page.id, pageId));
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
  opts: { actorUserId: string; projectId?: string | null; parentPageId?: string | null; titleSuffix?: string },
) {
  const source = await getPage(tx, pageId);
  const projectId = opts.projectId !== undefined ? opts.projectId : source.projectId;
  const parentPageId = opts.parentPageId !== undefined ? opts.parentPageId : source.parentPageId;

  const created = await createPage(tx, {
    organizationId: source.organizationId,
    projectId,
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
