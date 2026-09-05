import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../../lib/auth";
import { Route as SearchRoute } from "../search";
import { Route as IssuesRoute } from "../issues";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const searchHandlers = SearchRoute.options.server!.handlers as { GET: Handler };
const issuesHandlers = IssuesRoute.options.server!.handlers as { GET: Handler; POST: Handler };

function req(url: string, token?: string) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(url, { headers });
}

function postReq(url: string, token: string, body: unknown) {
  const headers = new Headers({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("/api/v1/search", () => {
  const orgId = "test-rest-search-org";
  const userId = "test-rest-search-user";
  const teamId = "test-rest-search-team";
  let token: string;
  let projectKey: string;

  async function cleanup() {
    await admin.delete(schema.issue).where(eq(schema.issue.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "REST Search Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });

    projectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: projectKey, name: "REST Search Test", actorUserId: userId }),
    );

    const auth = await getAuth();
    const created = await auth.api.createApiKey({
      body: { userId, permissions: { issues: ["read", "write"] }, metadata: { organizationId: orgId } },
    });
    token = created.key;

    await issuesHandlers.POST({
      request: postReq("http://x/api/v1/issues", token, { projectKey, title: "Fix the flaky login bug" }),
      params: {},
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await searchHandlers.GET({ request: req("http://x/api/v1/search?q=login"), params: {} });
    expect(res.status).toBe(401);
  });

  it("finds an issue by a substring of its title", async () => {
    const res = await searchHandlers.GET({ request: req("http://x/api/v1/search?q=flaky", token), params: {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].title).toBe("Fix the flaky login bug");
  });

  it("finds an issue by its exact key", async () => {
    const res = await searchHandlers.GET({ request: req(`http://x/api/v1/search?q=${projectKey.toUpperCase()}-1`, token), params: {} });
    const body = await res.json();
    expect(body.issues).toHaveLength(1);
  });
});
