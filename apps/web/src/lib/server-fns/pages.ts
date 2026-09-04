import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { loadEnv } from "@kompast/env";
import { inArray, schema } from "@kompast/db";
import {
  createPage,
  getPage,
  listPageTree,
  updatePageMeta,
  movePage,
  archivePage,
  restorePage,
  duplicatePage,
  canAccessPage,
  filterAccessiblePages,
  addPageComment,
  listPageComments,
  resolvePageComment,
  toggleFavoritePage,
  listFavoritePageIds,
  linkEntities,
  unlinkEntities,
  listOutgoingLinks,
  listBacklinks,
  signCollabToken,
  createShareLink,
  listShareLinks,
  revokeShareLink,
  withAuthorizedTenant,
  ForbiddenError,
} from "@kompast/core";
import { requireAuthContext } from "../session";

export const listPageTreeFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  return withAuthorizedTenant(ctx, async (tx) => {
    const [pages, favoriteIds] = await Promise.all([
      listPageTree(tx, ctx.organizationId, null),
      listFavoritePageIds(tx, ctx.userId),
    ]);
    const visible = await filterAccessiblePages(tx, pages, ctx);
    return { pages: visible, favoriteIds };
  });
});

const createPageSchema = z.object({
  title: z.string().optional(),
  parentPageId: z.string().nullable().optional(),
  type: z.enum(["doc", "template"]).optional(),
});

export const createPageFn = createServerFn({ method: "POST" })
  .validator(createPageSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      createPage(tx, {
        organizationId: ctx.organizationId,
        title: data.title,
        parentPageId: data.parentPageId,
        type: data.type,
        actorUserId: ctx.userId,
      }),
    );
  });

export const getPageDetailFn = createServerFn({ method: "GET" })
  .validator((pageId: string) => pageId)
  .handler(async ({ data: pageId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const page = await getPage(tx, pageId);
      const allowed = await canAccessPage(tx, pageId, ctx, "view");
      if (!allowed) throw new ForbiddenError(`No access to page ${pageId}`);

      const canEdit = await canAccessPage(tx, pageId, ctx, "edit");
      const [children, comments, outgoingLinks, backlinks, shareLinks, favoriteIds] = await Promise.all([
        listPageTree(tx, ctx.organizationId, page.projectId).then((all) => all.filter((p) => p.parentPageId === page.id)),
        listPageComments(tx, pageId),
        listOutgoingLinks(tx, "page", pageId),
        listBacklinks(tx, "page", pageId),
        listShareLinks(tx, pageId),
        listFavoritePageIds(tx, ctx.userId),
      ]);
      const isFavorited = favoriteIds.includes(pageId);

      const commentAuthorIds = [...new Set(comments.map((c) => c.authorId))];
      const users = commentAuthorIds.length > 0 ? await tx.select().from(schema.user).where(inArray(schema.user.id, commentAuthorIds)) : [];

      const linkedIssueIds = outgoingLinks.filter((l) => l.toType === "issue").map((l) => l.toId);
      const linkedIssues =
        linkedIssueIds.length > 0
          ? await tx
              .select({ id: schema.issue.id, title: schema.issue.title, keySeq: schema.issue.keySeq, projectId: schema.issue.projectId })
              .from(schema.issue)
              .where(inArray(schema.issue.id, linkedIssueIds))
          : [];
      const linkedProjectIds = [...new Set(linkedIssues.map((i) => i.projectId))];
      const linkedProjects =
        linkedProjectIds.length > 0
          ? await tx.select({ id: schema.project.id, key: schema.project.key }).from(schema.project).where(inArray(schema.project.id, linkedProjectIds))
          : [];

      const backlinkPageIds = backlinks.filter((l) => l.fromType === "page").map((l) => l.fromId);
      const backlinkPages =
        backlinkPageIds.length > 0
          ? await tx.select({ id: schema.page.id, title: schema.page.title, icon: schema.page.icon }).from(schema.page).where(inArray(schema.page.id, backlinkPageIds))
          : [];

      const collabToken = signCollabToken({
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        pageId,
        role: canEdit ? "edit" : "view",
      });

      return {
        page,
        children,
        comments,
        users,
        linkedIssues,
        linkedProjects,
        backlinkPages,
        shareLinks,
        canEdit,
        isFavorited,
        collabToken,
        collabWsUrl: loadEnv().COLLAB_WS_URL,
      };
    });
  });

const updatePageMetaSchema = z.object({ pageId: z.string(), title: z.string().optional(), icon: z.string().nullable().optional() });

export const updatePageMetaFn = createServerFn({ method: "POST" })
  .validator(updatePageMetaSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updatePageMeta(tx, data.pageId, { title: data.title, icon: data.icon }));
    return { ok: true } as const;
  });

const movePageSchema = z.object({ pageId: z.string(), parentPageId: z.string().nullable(), beforeId: z.string().optional(), afterId: z.string().optional() });

export const movePageFn = createServerFn({ method: "POST" })
  .validator(movePageSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => movePage(tx, data.pageId, data));
    return { ok: true } as const;
  });

export const archivePageFn = createServerFn({ method: "POST" })
  .validator((pageId: string) => pageId)
  .handler(async ({ data: pageId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => archivePage(tx, pageId));
    return { ok: true } as const;
  });

export const restorePageFn = createServerFn({ method: "POST" })
  .validator((pageId: string) => pageId)
  .handler(async ({ data: pageId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => restorePage(tx, pageId));
    return { ok: true } as const;
  });

const duplicatePageSchema = z.object({ pageId: z.string(), titleSuffix: z.string().optional() });

export const duplicatePageFn = createServerFn({ method: "POST" })
  .validator(duplicatePageSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      duplicatePage(tx, data.pageId, { actorUserId: ctx.userId, titleSuffix: data.titleSuffix ?? " (salinan)" }),
    );
  });

export const toggleFavoritePageFn = createServerFn({ method: "POST" })
  .validator((pageId: string) => pageId)
  .handler(async ({ data: pageId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => toggleFavoritePage(tx, pageId, ctx.userId));
  });

const addPageCommentSchema = z.object({ pageId: z.string(), blockId: z.string(), text: z.string().min(1) });

export const addPageCommentFn = createServerFn({ method: "POST" })
  .validator(addPageCommentSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      addPageComment(tx, { pageId: data.pageId, blockId: data.blockId, authorId: ctx.userId, bodyJson: { text: data.text } }),
    );
  });

export const resolvePageCommentFn = createServerFn({ method: "POST" })
  .validator((commentId: string) => commentId)
  .handler(async ({ data: commentId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => resolvePageComment(tx, commentId));
    return { ok: true } as const;
  });

const linkIssueSchema = z.object({ pageId: z.string(), issueId: z.string() });

export const linkPageToIssueFn = createServerFn({ method: "POST" })
  .validator(linkIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      linkEntities(tx, { organizationId: ctx.organizationId, fromType: "page", fromId: data.pageId, toType: "issue", toId: data.issueId, createdBy: ctx.userId }),
    );
    return { ok: true } as const;
  });

export const unlinkPageFromIssueFn = createServerFn({ method: "POST" })
  .validator(linkIssueSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => unlinkEntities(tx, { fromType: "page", fromId: data.pageId, toType: "issue", toId: data.issueId }));
    return { ok: true } as const;
  });

const createShareLinkSchema = z.object({
  pageId: z.string(),
  scope: z.enum(["view", "comment"]).optional(),
  includeEmbeds: z.boolean().optional(),
  password: z.string().min(1).optional(),
});

export const createShareLinkFn = createServerFn({ method: "POST" })
  .validator(createShareLinkSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      createShareLink(tx, { pageId: data.pageId, scope: data.scope, includeEmbeds: data.includeEmbeds, password: data.password, createdBy: ctx.userId }),
    );
  });

export const revokeShareLinkFn = createServerFn({ method: "POST" })
  .validator((shareLinkId: string) => shareLinkId)
  .handler(async ({ data: shareLinkId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => revokeShareLink(tx, shareLinkId));
    return { ok: true } as const;
  });
