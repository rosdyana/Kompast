import { and, eq, isNull, schema } from "@kompast/db";
import { createPage, resolveExternalRef, upsertExternalRef, syncPageMentions, type PageImportTarget, type Tx } from "@kompast/core";
import type { NotionExport, NotionExportPage } from "./types";

/** What a converted page's content resolves an internal Notion link to. */
export interface ImportedPageRef {
  pageId: string;
  title: string;
  icon: string | null;
}

/**
 * Turns one exported page into stored Yjs state. Injected rather than
 * written here because it needs @blocknote/server-util, whose jsdom
 * dependency must stay out of packages/core and packages/import (see
 * docs/ENGINEERING-NOTES.md, "REST API + MCP"); apps/web supplies it.
 */
export type NotionPageConverter = (
  page: NotionExportPage,
  ctx: { pageId: string; linkedPage: (notionId: string) => ImportedPageRef | null },
) => Promise<{ state: Uint8Array; mentionedPageIds: string[]; assetsUploaded: number }>;

export interface NotionLoadContext {
  organizationId: string;
  actorUserId: string;
  importRunId: string;
  /** Checked by the caller first (requirePageImportTarget). */
  target: PageImportTarget;
  dryRun: boolean;
  convertPage: NotionPageConverter;
}

export interface NotionLoadReport {
  counts: {
    pagesFound: number;
    pagesCreated: number;
    /** Already imported into this same space by an earlier run, and still there. Left untouched. */
    pagesSkipped: number;
    databases: number;
    assetsUploaded: number;
    filesNotImported: number;
  };
  /** Top-level pages this run created, so the UI can open the first one. */
  rootPageIds: string[];
  errors: { page: string; error: string }[];
}

/**
 * The idempotency key. It includes the target space, so re-running an
 * export into the same space skips what's already there, while importing
 * it into a different space (or by a different person, into their own
 * Private) makes an independent copy instead of pointing at pages its
 * importer may not be able to see.
 */
function sourceId(ctx: NotionLoadContext, notionId: string) {
  return `${ctx.target === "private" ? `private:${ctx.actorUserId}` : "workspace"}:${notionId}`;
}

/**
 * Two passes: create every page (parents first, so each child has its
 * parent's id), then convert content, once every link target exists.
 * Content is written straight into ydoc_state only for pages created
 * this run: no collab session can be open on a page that didn't exist a
 * moment ago (same reasoning as seedPageContentFromMarkdown). Pages from
 * an earlier run are never overwritten. Someone may have edited them, or
 * be editing them now.
 *
 * Each page runs in its own savepoint, so one bad page lands in
 * `errors` without aborting the transaction for the rest.
 */
export async function runNotionImport(tx: Tx, exp: NotionExport, ctx: NotionLoadContext): Promise<NotionLoadReport> {
  const report: NotionLoadReport = {
    counts: {
      pagesFound: exp.pages.length,
      pagesCreated: 0,
      pagesSkipped: 0,
      databases: exp.pages.filter((p) => p.database).length,
      assetsUploaded: 0,
      filesNotImported: exp.skipped.length,
    },
    rootPageIds: [],
    errors: [],
  };
  const imported = new Map<string, ImportedPageRef>();
  const created: { page: NotionExportPage; pageId: string }[] = [];

  for (const page of exp.pages) {
    const existingId = await existingPageId(tx, ctx, page.notionId);
    if (existingId) {
      imported.set(page.notionId, { pageId: existingId, title: page.title, icon: page.icon });
      report.counts.pagesSkipped++;
      continue;
    }
    if (ctx.dryRun) continue;

    try {
      const parentPageId = page.parentId ? (imported.get(page.parentId)?.pageId ?? null) : null;
      const row = await tx.transaction(async (sp) => {
        const row = await createPage(sp, {
          organizationId: ctx.organizationId,
          // A child takes its parent's space (createPage refuses a second, explicit one).
          ...(parentPageId ? {} : { privateOwnerId: ctx.target === "private" ? ctx.actorUserId : null }),
          parentPageId,
          title: page.title,
          icon: page.icon ?? undefined,
          actorUserId: ctx.actorUserId,
        });
        await upsertExternalRef(sp, {
          organizationId: ctx.organizationId,
          source: "notion",
          sourceId: sourceId(ctx, page.notionId),
          sourceUrl: page.notionId.startsWith("path:") ? undefined : `https://www.notion.so/${page.notionId}`,
          entityType: "page",
          entityId: row.id,
          importRunId: ctx.importRunId,
        });
        return row;
      });
      imported.set(page.notionId, { pageId: row.id, title: page.title, icon: page.icon });
      created.push({ page, pageId: row.id });
      if (!parentPageId) report.rootPageIds.push(row.id);
      report.counts.pagesCreated++;
    } catch (err) {
      report.errors.push({ page: page.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const { page, pageId } of created) {
    try {
      const content = await ctx.convertPage(page, { pageId, linkedPage: (notionId) => imported.get(notionId) ?? null });
      await tx.transaction(async (sp) => {
        await sp.insert(schema.ydocState).values({ pageId, state: Buffer.from(content.state) });
        await syncPageMentions(
          sp,
          ctx.organizationId,
          pageId,
          content.mentionedPageIds.map((id) => ({ type: "page" as const, id })),
        );
      });
      report.counts.assetsUploaded += content.assetsUploaded;
    } catch (err) {
      // The page itself stays (empty), so links to it from other pages still resolve.
      report.errors.push({ page: page.path, error: `Content not imported: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return report;
}

/**
 * A page an earlier run made, if the caller can still see it and it isn't
 * in the trash. Otherwise the import makes a fresh one and re-points the
 * external_ref at it: a page someone deleted or trashed should come back
 * on re-import, not silently stay missing.
 */
async function existingPageId(tx: Tx, ctx: NotionLoadContext, notionId: string): Promise<string | null> {
  const ref = await resolveExternalRef(tx, ctx.organizationId, "notion", sourceId(ctx, notionId));
  if (!ref) return null;
  const [page] = await tx
    .select({ id: schema.page.id })
    .from(schema.page)
    .where(and(eq(schema.page.id, ref.entityId), isNull(schema.page.archivedAt)));
  return page?.id ?? null;
}
