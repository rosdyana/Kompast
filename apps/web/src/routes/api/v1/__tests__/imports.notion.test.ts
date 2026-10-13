import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, eq, inArray, adminDb as admin } from "@kompast/db";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../../lib/auth";
import { Route as NotionImportRoute } from "../imports.notion";
import { Route as PageAssetRoute } from "../../page-assets.$pageId.$";
import { notionMarkdownExportZip } from "../../../../../../../packages/import/src/__tests__/fixtures/notion";

// Imported files go through the storage driver; keep them out of the dev storage dir.
const stored = new Map<string, number>();
vi.mock("@kompast/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kompast/storage")>()),
  getStorageDriver: () => ({
    putObject: async (key: string, data: Buffer) => void stored.set(key, data.length),
    getDownloadUrl: async (key: string) => `https://storage.test/${key}?sig=1`,
    getUploadUrl: async () => {
      throw new Error("unused");
    },
    delete: async () => {},
  }),
}));

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const importPost = (NotionImportRoute.options.server!.handlers as { POST: Handler }).POST;
const assetGet = (PageAssetRoute.options.server!.handlers as { GET: Handler }).GET;

function upload(token: string, fields: Record<string, string>, zip: Uint8Array | null = notionMarkdownExportZip()) {
  const form = new FormData();
  if (zip) form.set("file", new File([new Uint8Array(zip)], "Export.zip", { type: "application/zip" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return importPost({
    request: new Request("http://x/api/v1/imports/notion", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }),
    params: {},
  });
}

describe("/api/v1/imports/notion", () => {
  const orgId = "test-rest-notion-org";
  const ownerId = "test-rest-notion-owner";
  const memberId = "test-rest-notion-member";
  const otherId = "test-rest-notion-other";
  const userIds = [ownerId, memberId, otherId];
  const tokens: Record<string, string> = {};

  async function cleanup() {
    await admin.delete(schema.link).where(eq(schema.link.organizationId, orgId));
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.apikey).where(inArray(schema.apikey.referenceId, userIds));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.id, userIds));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    stored.clear();
    await admin.insert(schema.organization).values({ id: orgId, name: "REST Notion Org", slug: orgId });
    for (const userId of userIds) await admin.insert(schema.user).values({ id: userId, name: userId, email: `${userId}@example.com` });
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: ownerId, role: "owner" },
      { id: id("mem"), organizationId: orgId, userId: memberId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: otherId, role: "member" },
    ]);
    const auth = await getAuth();
    for (const userId of userIds) {
      const created = await auth.api.createApiKey({ body: { userId, permissions: { pages: ["read", "write"] }, metadata: { organizationId: orgId } } });
      tokens[userId] = created.key;
    }
  });

  afterAll(async () => {
    await cleanup();
  });

  it("a member imports into their Private space; images are served only to people who can see the page", async () => {
    const res = await upload(tokens[memberId]!, { target: "private" });
    expect(res.status).toBe(201);
    const { importRunId, report } = await res.json();
    expect(report.counts).toMatchObject({ pagesFound: 4, pagesCreated: 4, databases: 1, assetsUploaded: 1 });
    expect(report.errors).toEqual([]);

    const pages = await admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId));
    expect(pages.every((p) => p.privateOwnerId === memberId)).toBe(true);
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run).toMatchObject({ status: "completed", source: "notion", projectId: null, createdBy: memberId });

    const [key] = [...stored.keys()];
    const [, pageId, name] = key!.split("/");
    expect(pages.find((p) => p.title === "Notes")!.id).toBe(pageId);

    const ok = await assetGet({ request: new Request(`http://x/api/page-assets/${pageId}/${name}`, { headers: { authorization: `Bearer ${tokens[memberId]}` } }), params: { pageId: pageId!, _splat: name! } });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe(`https://storage.test/${key}?sig=1`);

    const hidden = await assetGet({ request: new Request(`http://x/api/page-assets/${pageId}/${name}`, { headers: { authorization: `Bearer ${tokens[otherId]}` } }), params: { pageId: pageId!, _splat: name! } });
    expect(hidden.status).toBe(404);
    const traversal = await assetGet({ request: new Request("http://x/", { headers: { authorization: `Bearer ${tokens[memberId]}` } }), params: { pageId: pageId!, _splat: "../other/x.png" } });
    expect(traversal.status).toBe(404);
  });

  it("only a workspace admin can import into Workspace docs", async () => {
    const refused = await upload(tokens[memberId]!, { target: "workspace" });
    expect(refused.status).toBe(403);
    expect(await admin.select().from(schema.importRun).where(eq(schema.importRun.organizationId, orgId))).toHaveLength(0);

    const res = await upload(tokens[ownerId]!, { target: "workspace" });
    expect(res.status).toBe(201);
    const pages = await admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId));
    expect(pages).toHaveLength(4);
    expect(pages.every((p) => p.privateOwnerId === null && p.teamId === null && p.projectId === null)).toBe(true);
  });

  it("dry run writes nothing; bad input is a 400/422 with the run marked failed", async () => {
    const dry = await upload(tokens[memberId]!, { target: "private", dryRun: "true" });
    expect(dry.status).toBe(200);
    expect((await dry.json()).report.counts).toMatchObject({ pagesFound: 4, pagesCreated: 0 });
    expect(await admin.select().from(schema.page).where(eq(schema.page.organizationId, orgId))).toHaveLength(0);
    expect(stored.size).toBe(0);

    expect((await upload(tokens[memberId]!, { target: "team" })).status).toBe(400);
    expect((await upload(tokens[memberId]!, { target: "private" }, null)).status).toBe(400);

    const notAZip = await upload(tokens[memberId]!, { target: "private" }, new TextEncoder().encode("hello"));
    expect(notAZip.status).toBe(422);
    const { importRunId } = await notAZip.json();
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run?.status).toBe("failed");
  });
});
