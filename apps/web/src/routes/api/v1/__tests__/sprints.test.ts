import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../../lib/auth";
import { Route as SprintsRoute } from "../sprints";
import { Route as SprintItemRoute } from "../sprints.$sprintId";
import { Route as StartRoute } from "../sprints.$sprintId.start";
import { Route as CompleteRoute } from "../sprints.$sprintId.complete";
import { Route as SprintIssuesRoute } from "../sprints.$sprintId.issues";
import { Route as SprintReportRoute } from "../sprints.$sprintId.report";
import { Route as VelocityRoute } from "../velocity";
import { Route as IssuesRoute } from "../issues";
import { Route as TransitionRoute } from "../issues.$issueKey.transition";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const sprintsHandlers = SprintsRoute.options.server!.handlers as { GET: Handler; POST: Handler };
const sprintItemHandlers = SprintItemRoute.options.server!.handlers as { GET: Handler };
const startHandlers = StartRoute.options.server!.handlers as { POST: Handler };
const completeHandlers = CompleteRoute.options.server!.handlers as { POST: Handler };
const sprintIssuesHandlers = SprintIssuesRoute.options.server!.handlers as { GET: Handler; POST: Handler; DELETE: Handler };
const sprintReportHandlers = SprintReportRoute.options.server!.handlers as { GET: Handler };
const velocityHandlers = VelocityRoute.options.server!.handlers as { GET: Handler };
const issuesHandlers = IssuesRoute.options.server!.handlers as { GET: Handler; POST: Handler };
const transitionHandlers = TransitionRoute.options.server!.handlers as { POST: Handler };

function req(url: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: options.method ?? "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
}

describe("/api/v1/sprints", () => {
  const orgId = "test-rest-sprints-org";
  const userId = "test-rest-sprints-user";
  let token: string;
  let projectKey: string;

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "REST Sprints Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });

    projectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, key: projectKey, name: "REST Sprint Test", actorUserId: userId }),
    );

    const auth = await getAuth();
    const created = await auth.api.createApiKey({
      body: { userId, permissions: { issues: ["read", "write"], sprints: ["write"] }, metadata: { organizationId: orgId } },
    });
    token = created.key;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates a sprint and lists it filtered by projectKey", async () => {
    const create = await sprintsHandlers.POST({ request: req("http://x/api/v1/sprints", { method: "POST", token, body: { projectKey, name: "Sprint 1", cycle: "1w" } }), params: {} });
    expect(create.status).toBe(201);

    const list = await (await sprintsHandlers.GET({ request: req(`http://x/api/v1/sprints?projectKey=${projectKey}`, { token }), params: {} })).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].name).toBe("Sprint 1");
    expect(list.data[0].state).toBe("future");
  });

  it("adds an issue to a sprint, starts it, and completes it, carrying not-done issues to the backlog", async () => {
    const sprintId = (await (await sprintsHandlers.POST({ request: req("http://x/api/v1/sprints", { method: "POST", token, body: { projectKey, name: "Sprint 1" } }), params: {} })).json()).id;

    const doneIssue = await (await issuesHandlers.POST({ request: req("http://x/api/v1/issues", { method: "POST", token, body: { projectKey, title: "Done issue" } }), params: {} })).json();
    const notDoneIssue = await (await issuesHandlers.POST({ request: req("http://x/api/v1/issues", { method: "POST", token, body: { projectKey, title: "Not done issue" } }), params: {} })).json();

    await sprintIssuesHandlers.POST({ request: req(`http://x/api/v1/sprints/${sprintId}/issues`, { method: "POST", token, body: { issueKey: doneIssue.key } }), params: { sprintId } });
    await sprintIssuesHandlers.POST({ request: req(`http://x/api/v1/sprints/${sprintId}/issues`, { method: "POST", token, body: { issueKey: notDoneIssue.key } }), params: { sprintId } });

    // Move the "done" issue to a done-category status before completing.
    await transitionHandlers.POST({
      request: req(`http://x/api/v1/issues/${doneIssue.key}/transition`, { method: "POST", token, body: { status: "Done" } }),
      params: { issueKey: doneIssue.key },
    });

    const startRes = await startHandlers.POST({ request: req(`http://x/api/v1/sprints/${sprintId}/start`, { method: "POST", token }), params: { sprintId } });
    expect(startRes.status).toBe(200);

    const getRes = await sprintItemHandlers.GET({ request: req(`http://x/api/v1/sprints/${sprintId}`, { token }), params: { sprintId } });
    const got = await getRes.json();
    expect(got.state).toBe("active");
    expect(got.report.scopeIssueCount).toBe(2);

    const completeRes = await completeHandlers.POST({ request: req(`http://x/api/v1/sprints/${sprintId}/complete`, { method: "POST", token, body: {} }), params: { sprintId } });
    const completed = await completeRes.json();
    expect(completed.completedIssueCount).toBe(1);
    expect(completed.carriedIssueCount).toBe(1);

    const sprintIssuesAfter = await (await sprintIssuesHandlers.GET({ request: req(`http://x/api/v1/sprints/${sprintId}/issues`, { token }), params: { sprintId } })).json();
    expect(sprintIssuesAfter.data.map((i: { id: string }) => i.id)).toEqual([doneIssue.id]);
  });

  it("rejects sprint creation from a token without sprints:write", async () => {
    const auth = await getAuth();
    const readOnly = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read"] }, metadata: { organizationId: orgId } } });
    const res = await sprintsHandlers.POST({ request: req("http://x/api/v1/sprints", { method: "POST", token: readOnly.key, body: { projectKey, name: "Nope" } }), params: {} });
    expect(res.status).toBe(401);
  });

  it("reports burndown/CFD for a started sprint and velocity for a completed one", async () => {
    const sprintId = (await (await sprintsHandlers.POST({ request: req("http://x/api/v1/sprints", { method: "POST", token, body: { projectKey, name: "Report Sprint", cycle: "1w" } }), params: {} })).json()).id;
    const issue = await (await issuesHandlers.POST({ request: req("http://x/api/v1/issues", { method: "POST", token, body: { projectKey, title: "Reported issue" } }), params: {} })).json();
    await sprintIssuesHandlers.POST({ request: req(`http://x/api/v1/sprints/${sprintId}/issues`, { method: "POST", token, body: { issueKey: issue.key } }), params: { sprintId } });
    await startHandlers.POST({ request: req(`http://x/api/v1/sprints/${sprintId}/start`, { method: "POST", token }), params: { sprintId } });

    const report = await (await sprintReportHandlers.GET({ request: req(`http://x/api/v1/sprints/${sprintId}/report`, { token }), params: { sprintId } })).json();
    expect(report.burndown.length).toBeGreaterThan(0);
    expect(report.burndown.at(-1).scopePoints).toBe(0);
    expect(report.cumulativeFlow.at(-1).todo).toBe(1);

    await completeHandlers.POST({ request: req(`http://x/api/v1/sprints/${sprintId}/complete`, { method: "POST", token, body: {} }), params: { sprintId } });

    const velocity = await (await velocityHandlers.GET({ request: req(`http://x/api/v1/velocity?projectKey=${projectKey}`, { token }), params: {} })).json();
    expect(velocity.data).toEqual([{ sprintId, sprintName: "Report Sprint", completedPoints: 0 }]);
  });
});
