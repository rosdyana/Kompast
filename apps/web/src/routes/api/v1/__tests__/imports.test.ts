import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../../lib/auth";
import { Route as ImportsRoute } from "../imports";
import { Route as ImportRunRoute } from "../imports.$importRunId";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const importsHandlers = ImportsRoute.options.server!.handlers as { GET: Handler; POST: Handler };
const importRunHandlers = ImportRunRoute.options.server!.handlers as { GET: Handler };

function req(url: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { method: options.method ?? "GET", headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined });
}

function jiraSearchResponse(issues: unknown[]): Response {
  return new Response(JSON.stringify({ startAt: 0, maxResults: 100, total: issues.length, issues }), { status: 200, headers: { "content-type": "application/json" } });
}

const FIXTURE_ISSUE = {
  id: "1",
  key: "DEMO-1",
  fields: {
    summary: "Imported via REST",
    issuetype: { name: "Task", subtask: false },
    status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
    assignee: null,
    reporter: null,
    priority: { name: "High" },
    labels: ["x"],
    description: null,
    created: "2022-05-01T00:00:00.000+0000",
  },
};

describe("/api/v1/imports", () => {
  const orgId = "test-rest-imports-org";
  const userId = "test-rest-imports-user";
  const teamId = "test-rest-imports-team";
  let token: string;
  let projectKey: string;

  async function cleanup() {
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "REST Imports Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });

    projectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: projectKey, name: "REST Imports Test", actorUserId: userId }),
    );

    const auth = await getAuth();
    const created = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read", "write"] }, metadata: { organizationId: orgId } } });
    token = created.key;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("a dry run reports the mapping and creates no issue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jiraSearchResponse([FIXTURE_ISSUE])));

    const res = await importsHandlers.POST({
      request: req("http://x/api/v1/imports", {
        method: "POST",
        token,
        body: { source: "jira", projectKey, jiraBaseUrl: "https://demo.atlassian.net", jiraEmail: "a@example.com", jiraApiToken: "tok", jql: "project = DEMO", dryRun: true },
      }),
      params: {},
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.report.counts.issuesCreated).toBe(0);
    expect(body.report.typeMapping[0]).toMatchObject({ jiraTypeName: "Task" });

    const issues = await admin.select().from(schema.issue).where(eq(schema.issue.organizationId, orgId));
    expect(issues).toHaveLength(0);
  });

  it("a real run creates the issue, and the run is readable via list + detail endpoints", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jiraSearchResponse([FIXTURE_ISSUE])));

    const createRes = await importsHandlers.POST({
      request: req("http://x/api/v1/imports", {
        method: "POST",
        token,
        body: { source: "jira", projectKey, jiraBaseUrl: "https://demo.atlassian.net", jiraEmail: "a@example.com", jiraApiToken: "tok", jql: "project = DEMO" },
      }),
      params: {},
    });
    expect(createRes.status).toBe(201);
    const { importRunId, report } = await createRes.json();
    expect(report.counts.issuesCreated).toBe(1);

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.organizationId, orgId));
    expect(issue?.title).toBe("Imported via REST");
    expect(issue?.origin).toBe("import");

    const listRes = await importsHandlers.GET({ request: req(`http://x/api/v1/imports?projectKey=${projectKey}`, { token }), params: {} });
    const list = await listRes.json();
    expect(list.data.map((r: { id: string }) => r.id)).toContain(importRunId);

    const detailRes = await importRunHandlers.GET({ request: req(`http://x/api/v1/imports/${importRunId}`, { token }), params: { importRunId } });
    const detail = await detailRes.json();
    expect(detail.status).toBe("completed");
  });

  it("a JIRA fetch failure marks the run failed and returns 502 with the importRunId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })));

    const res = await importsHandlers.POST({
      request: req("http://x/api/v1/imports", {
        method: "POST",
        token,
        body: { source: "jira", projectKey, jiraBaseUrl: "https://demo.atlassian.net", jiraEmail: "a@example.com", jiraApiToken: "wrong", jql: "project = DEMO" },
      }),
      params: {},
    });
    expect(res.status).toBe(502);
    const { importRunId } = await res.json();

    const detailRes = await importRunHandlers.GET({ request: req(`http://x/api/v1/imports/${importRunId}`, { token }), params: { importRunId } });
    const detail = await detailRes.json();
    expect(detail.status).toBe("failed");
  });

  it("rejects starting an import from a token without issues:write", async () => {
    const auth = await getAuth();
    const readOnly = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read"] }, metadata: { organizationId: orgId } } });
    const res = await importsHandlers.POST({
      request: req("http://x/api/v1/imports", {
        method: "POST",
        token: readOnly.key,
        body: { source: "jira", projectKey, jiraBaseUrl: "https://demo.atlassian.net", jiraEmail: "a@example.com", jiraApiToken: "tok", jql: "project = DEMO" },
      }),
      params: {},
    });
    expect(res.status).toBe(401);
  });
});
