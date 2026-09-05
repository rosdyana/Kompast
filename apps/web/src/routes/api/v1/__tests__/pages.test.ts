import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../../lib/auth";
import { Route as PagesRoute } from "../pages";
import { Route as PageItemRoute } from "../pages.$pageId";
import { Route as PageCommentsRoute } from "../pages.$pageId.comments";
import { Route as PageLinksRoute } from "../pages.$pageId.links";
import { Route as IssuesRoute } from "../issues";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
interface Handlers {
  GET: Handler;
  POST: Handler;
  PATCH?: Handler;
  DELETE?: Handler;
}
const pagesHandlers = PagesRoute.options.server!.handlers as Handlers;
const pageItemHandlers = PageItemRoute.options.server!.handlers as Handlers;
const pageCommentsHandlers = PageCommentsRoute.options.server!.handlers as Handlers;
const pageLinksHandlers = PageLinksRoute.options.server!.handlers as Handlers;
const issuesHandlers = IssuesRoute.options.server!.handlers as Handlers;

function req(url: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

describe("/api/v1/pages", () => {
  const orgId = "test-rest-pages-org";
  const userId = "test-rest-pages-user";
  const teamId = "test-rest-pages-team";
  let token: string;
  let projectKey: string;

  async function cleanup() {
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "REST Pages Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });

    const ctx = { userId, organizationId: orgId };
    projectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: projectKey, name: "REST Page Test", actorUserId: userId }));

    const auth = await getAuth();
    const created = await auth.api.createApiKey({
      body: { userId, permissions: { pages: ["read", "write"], issues: ["read", "write"] }, metadata: { organizationId: orgId } },
    });
    token = created.key;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates a workspace-level page with initial markdown content and reads it back rendered", async () => {
    const createRes = await pagesHandlers.POST({
      request: req("http://x/api/v1/pages", { method: "POST", token, body: { title: "Design doc", content: "# Hello\n\nSome text." } }),
      params: {},
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.title).toBe("Design doc");

    const getRes = await pageItemHandlers.GET({ request: req(`http://x/api/v1/pages/${created.id}`, { token }), params: { pageId: created.id } });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.content).toContain("Hello");
    expect(fetched.content).toContain("Some text");
  });

  it("creates a project-scoped page and lists it filtered by projectKey", async () => {
    await pagesHandlers.POST({
      request: req("http://x/api/v1/pages", { method: "POST", token, body: { title: "Project doc", projectKey } }),
      params: {},
    });

    const listRes = await pagesHandlers.GET({ request: req(`http://x/api/v1/pages?projectKey=${projectKey}`, { token }), params: {} });
    const list = await listRes.json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].title).toBe("Project doc");
  });

  it("updates a page's title via PATCH", async () => {
    const created = await (
      await pagesHandlers.POST({ request: req("http://x/api/v1/pages", { method: "POST", token, body: { title: "Old title" } }), params: {} })
    ).json();

    const patchRes = await pageItemHandlers.PATCH!({
      request: req(`http://x/api/v1/pages/${created.id}`, { method: "PATCH", token, body: { title: "New title" } }),
      params: { pageId: created.id },
    });
    expect(patchRes.status).toBe(200);

    const [row] = await admin.select().from(schema.page).where(eq(schema.page.id, created.id));
    expect(row?.title).toBe("New title");
  });

  it("returns 404 for a page the caller has no access to, not 403 (no existence leak)", async () => {
    const restricted = await (
      await pagesHandlers.POST({ request: req("http://x/api/v1/pages", { method: "POST", token, body: { title: "Secret" } }), params: {} })
    ).json();

    const otherUserId = "test-rest-pages-other-user";
    await admin.insert(schema.user).values({ id: otherUserId, name: "Other", email: `${otherUserId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId: otherUserId, role: "member" });
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      import("@kompast/core").then(({ setPagePermission }) => setPagePermission(tx, restricted.id, { type: "user", id: userId }, "full")),
    );

    const auth = await getAuth();
    const otherToken = await auth.api.createApiKey({
      body: { userId: otherUserId, permissions: { pages: ["read"] }, metadata: { organizationId: orgId } },
    });

    const res = await pageItemHandlers.GET({
      request: req(`http://x/api/v1/pages/${restricted.id}`, { token: otherToken.key }),
      params: { pageId: restricted.id },
    });
    expect(res.status).toBe(404);

    await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, otherUserId));
    await admin.delete(schema.member).where(eq(schema.member.userId, otherUserId));
    await admin.delete(schema.user).where(eq(schema.user.id, otherUserId));
  });

  it("adds and lists comments on a page", async () => {
    const created = await (
      await pagesHandlers.POST({ request: req("http://x/api/v1/pages", { method: "POST", token, body: { title: "Commented doc" } }), params: {} })
    ).json();

    const addRes = await pageCommentsHandlers.POST({
      request: req(`http://x/api/v1/pages/${created.id}/comments`, { method: "POST", token, body: { text: "Nice doc" } }),
      params: { pageId: created.id },
    });
    expect(addRes.status).toBe(201);

    const listRes = await pageCommentsHandlers.GET({ request: req(`http://x/api/v1/pages/${created.id}/comments`, { token }), params: { pageId: created.id } });
    const list = await listRes.json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].text).toBe("Nice doc");
  });

  it("links a page to an issue and unlinks it", async () => {
    const page = await (
      await pagesHandlers.POST({ request: req("http://x/api/v1/pages", { method: "POST", token, body: { title: "Linked doc" } }), params: {} })
    ).json();
    const issue = await (
      await issuesHandlers.POST({ request: req("http://x/api/v1/issues", { method: "POST", token, body: { projectKey, title: "Linked issue" } }), params: {} })
    ).json();

    const linkRes = await pageLinksHandlers.POST({
      request: req(`http://x/api/v1/pages/${page.id}/links`, { method: "POST", token, body: { issueKey: issue.key } }),
      params: { pageId: page.id },
    });
    expect(linkRes.status).toBe(201);

    const listRes = await pageLinksHandlers.GET({ request: req(`http://x/api/v1/pages/${page.id}/links`, { token }), params: { pageId: page.id } });
    expect((await listRes.json()).linkedIssueIds).toEqual([issue.id]);

    const unlinkRes = await pageLinksHandlers.DELETE!({
      request: req(`http://x/api/v1/pages/${page.id}/links?issueKey=${issue.key}`, { method: "DELETE", token }),
      params: { pageId: page.id },
    });
    expect(unlinkRes.status).toBe(200);

    const afterUnlink = await pageLinksHandlers.GET({ request: req(`http://x/api/v1/pages/${page.id}/links`, { token }), params: { pageId: page.id } });
    expect((await afterUnlink.json()).linkedIssueIds).toEqual([]);
  });
});
