import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../../lib/auth";
import { Route as RoadmapRoute } from "../roadmap";
import { Route as IssuesRoute } from "../issues";
import { Route as IssueItemRoute } from "../issues.$issueKey";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const roadmapHandlers = RoadmapRoute.options.server!.handlers as { GET: Handler };
const issuesHandlers = IssuesRoute.options.server!.handlers as { GET: Handler; POST: Handler };
const issueItemHandlers = IssueItemRoute.options.server!.handlers as { GET: Handler; PATCH: Handler };

function req(url: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: options.method ?? "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
}

describe("/api/v1/roadmap", () => {
  const orgId = "test-rest-roadmap-org";
  const userId = "test-rest-roadmap-user";
  const teamId = "test-rest-roadmap-team";
  let token: string;
  let projectKey: string;

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "REST Roadmap Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });

    projectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: projectKey, name: "REST Roadmap Test", actorUserId: userId }),
    );

    const auth = await getAuth();
    const created = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read", "write"] }, metadata: { organizationId: orgId } } });
    token = created.key;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("links an issue to an epic via PATCH epicKey and the roadmap reflects it", async () => {
    const epic = await (await issuesHandlers.POST({ request: req("http://x/api/v1/issues", { method: "POST", token, body: { projectKey, title: "Epic A", type: "Epic" } }), params: {} })).json();
    const story = await (await issuesHandlers.POST({ request: req("http://x/api/v1/issues", { method: "POST", token, body: { projectKey, title: "Story A", type: "Story" } }), params: {} })).json();

    const patchRes = await issueItemHandlers.PATCH({ request: req(`http://x/api/v1/issues/${story.key}`, { method: "PATCH", token, body: { epicKey: epic.key } }), params: { issueKey: story.key } });
    expect(patchRes.status).toBe(200);

    const get = await (await issueItemHandlers.GET({ request: req(`http://x/api/v1/issues/${story.key}`, { token }), params: { issueKey: story.key } })).json();
    expect(get.epicId).toBeTruthy();

    const roadmap = await (await roadmapHandlers.GET({ request: req(`http://x/api/v1/roadmap?projectKey=${projectKey}`, { token }), params: {} })).json();
    expect(roadmap.data).toEqual([{ key: epic.key, title: "Epic A", startDate: null, dueDate: null, childCount: 1, doneCount: 0 }]);
  });
});
