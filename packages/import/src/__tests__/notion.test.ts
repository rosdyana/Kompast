import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, inArray } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createImportRun, ForbiddenError, requirePageImportTarget, withAuthorizedTenant, type PageImportTarget } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { readNotionExport } from "../notion/extract";
import { runNotionImport, type NotionPageConverter } from "../notion/load";
import { IDS, notionHtmlExportZip } from "./fixtures/notion";

describe("Notion importer", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-notion-import-org";
  const ownerId = "test-notion-import-owner";
  const memberId = "test-notion-import-member";
  const otherId = "test-notion-import-other";
  const userIds = [ownerId, memberId, otherId];

  async function cleanup() {
    await admin.delete(schema.link).where(eq(schema.link.organizationId, orgId));
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.id, userIds));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Notion Import Test Org", slug: orgId });
    for (const userId of userIds) await admin.insert(schema.user).values({ id: userId, name: userId, email: `${userId}@example.com` });
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: ownerId, role: "owner" },
      { id: id("mem"), organizationId: orgId, userId: memberId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: otherId, role: "member" },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  // Real conversion needs BlockNote + jsdom (apps/web; tested there). This
  // stub mentions the page's parent, to prove link targets resolve.
  const convertPage: NotionPageConverter = async (page, ctx) => ({
    state: new Uint8Array([0, 0]),
    mentionedPageIds: page.parentId ? [ctx.linkedPage(page.parentId)!.pageId] : [],
    assetsUploaded: 0,
  });

  async function runImport(userId: string, target: PageImportTarget, dryRun = false) {
    const ctx = { userId, organizationId: orgId };
    const exp = readNotionExport(notionHtmlExportZip());
    return withAuthorizedTenant(ctx, async (tx) => {
      await requirePageImportTarget(tx, ctx, target);
      const { importRunId } = await createImportRun(tx, { organizationId: orgId, projectId: null, source: "notion", dryRun, config: { target }, createdBy: userId });
      return runNotionImport(tx, exp, { organizationId: orgId, actorUserId: userId, importRunId, target, dryRun, convertPage });
    });
  }

  const pagesOf = () => admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId));

  it("only workspace owners/admins (or the super admin) may import into Workspace docs; anyone into Private", async () => {
    await expect(runImport(memberId, "workspace")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await pagesOf()).toHaveLength(0);
    await expect(requirePageImportTarget(admin as never, { userId: memberId, organizationId: orgId }, "private")).resolves.toBeUndefined();

    await admin.update(schema.member).set({ isSuperAdmin: true }).where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, memberId)));
    await expect(requirePageImportTarget(admin as never, { userId: memberId, organizationId: orgId }, "workspace")).resolves.toBeUndefined();
  });

  it("imports into the caller's Private space: whole tree private, content stored, links become backlinks, invisible to others", async () => {
    const report = await runImport(memberId, "private");

    expect(report.counts).toMatchObject({ pagesFound: 3, pagesCreated: 3, pagesSkipped: 0 });
    expect(report.errors).toEqual([]);
    const pages = await pagesOf();
    expect(pages).toHaveLength(3);
    expect(pages.every((p) => p.privateOwnerId === memberId && p.teamId === null && p.projectId === null)).toBe(true);

    const wiki = pages.find((p) => p.title === "Team Wiki & Docs")!;
    const onboarding = pages.find((p) => p.title === "Onboarding")!;
    expect(wiki).toMatchObject({ icon: "📚", parentPageId: null, createdBy: memberId });
    expect(onboarding.parentPageId).toBe(wiki.id);
    expect(report.rootPageIds.sort()).toEqual(pages.filter((p) => !p.parentPageId).map((p) => p.id).sort());

    const states = await admin.select().from(schema.ydocState).where(inArray(schema.ydocState.pageId, pages.map((p) => p.id)));
    expect(states).toHaveLength(3);
    const links = await admin.select().from(schema.link).where(eq(schema.link.organizationId, orgId));
    expect(links).toEqual([expect.objectContaining({ fromId: onboarding.id, toId: wiki.id, kind: "mention" })]);

    const seenByOther = await withAuthorizedTenant({ userId: otherId, organizationId: orgId }, (tx) => tx.select().from(schema.page));
    expect(seenByOther.filter((p) => p.organizationId === orgId)).toHaveLength(0);
    // The run is project-less, so only the person who started it can see it.
    const runsSeenByOther = await withAuthorizedTenant({ userId: otherId, organizationId: orgId }, (tx) => tx.select().from(schema.importRun));
    expect(runsSeenByOther.filter((r) => r.organizationId === orgId)).toHaveLength(0);
    const runsSeenByMember = await withAuthorizedTenant({ userId: memberId, organizationId: orgId }, (tx) => tx.select().from(schema.importRun));
    expect(runsSeenByMember.filter((r) => r.organizationId === orgId)).toHaveLength(1);
  });

  it("re-running skips what's already there, brings back trashed pages, and copies independently per space and person", async () => {
    await runImport(memberId, "private");
    const again = await runImport(memberId, "private");
    expect(again.counts).toMatchObject({ pagesCreated: 0, pagesSkipped: 3 });
    expect(await pagesOf()).toHaveLength(3);

    const roadmap = (await pagesOf()).find((p) => p.title === "Roadmap")!;
    await admin.update(schema.page).set({ archivedAt: new Date() }).where(eq(schema.page.id, roadmap.id));
    const afterTrash = await runImport(memberId, "private");
    expect(afterTrash.counts).toMatchObject({ pagesCreated: 1, pagesSkipped: 2 });
    const ref = await admin.select().from(schema.externalRef).where(eq(schema.externalRef.sourceId, `private:${memberId}:${IDS.roadmap}`));
    expect(ref[0]!.entityId).not.toBe(roadmap.id);

    const otherCopy = await runImport(otherId, "private");
    expect(otherCopy.counts.pagesCreated).toBe(3);
    const workspaceCopy = await runImport(ownerId, "workspace");
    expect(workspaceCopy.counts.pagesCreated).toBe(3);
    const workspacePages = (await pagesOf()).filter((p) => !p.privateOwnerId);
    expect(workspacePages).toHaveLength(3);
  });

  it("dry run counts without writing pages", async () => {
    const report = await runImport(memberId, "private", true);
    expect(report.counts).toMatchObject({ pagesFound: 3, pagesCreated: 0, pagesSkipped: 0 });
    expect(await pagesOf()).toHaveLength(0);
  });

  it("a page whose content fails to convert is still created (empty), with the error reported", async () => {
    const ctx = { userId: memberId, organizationId: orgId };
    const exp = readNotionExport(notionHtmlExportZip());
    const report = await withAuthorizedTenant(ctx, async (tx) => {
      const { importRunId } = await createImportRun(tx, { organizationId: orgId, projectId: null, source: "notion", dryRun: false, config: {}, createdBy: memberId });
      return runNotionImport(tx, exp, {
        organizationId: orgId,
        actorUserId: memberId,
        importRunId,
        target: "private",
        dryRun: false,
        convertPage: async (page, c) => {
          if (page.notionId === IDS.roadmap) throw new Error("bad block");
          return convertPage(page, c);
        },
      });
    });
    expect(report.counts.pagesCreated).toBe(3);
    expect(report.errors).toEqual([{ page: `Roadmap ${IDS.roadmap}.html`, error: "Content not imported: bad block" }]);
    expect(await admin.select().from(schema.ydocState).where(inArray(schema.ydocState.pageId, (await pagesOf()).map((p) => p.id)))).toHaveLength(2);
  });
});
