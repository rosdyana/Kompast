import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../../lib/auth";
import { adminDb as admin } from "@kompast/db";
import { Route as IssuesRoute } from "../issues";
import { Route as IssueItemRoute } from "../issues.$issueKey";
import { Route as TransitionRoute } from "../issues.$issueKey.transition";
import { Route as CommentsRoute } from "../issues.$issueKey.comments";

// The `handlers` type is a union with a function-factory form TS can't
// rule out statically; the runtime value here is always the plain object
// form (confirmed by inspection), so a direct cast is the correct fix, not
// a workaround.
type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
interface Handlers {
  GET: Handler;
  POST: Handler;
  PATCH: Handler;
}
const issuesHandlers = IssuesRoute.options.server!.handlers as Handlers;
const issueItemHandlers = IssueItemRoute.options.server!.handlers as Handlers;
const transitionHandlers = TransitionRoute.options.server!.handlers as Handlers;
const commentsHandlers = CommentsRoute.options.server!.handlers as Handlers;

function req(url: string, options: { method?: string; token?: string; body?: unknown; idempotencyKey?: string } = {}) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
  return new Request(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

describe("/api/v1/issues", () => {
  const orgId = "test-rest-issues-org";
  const userId = "test-rest-issues-user";
  const teamId = "test-rest-issues-team";
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
    await admin.insert(schema.organization).values({ id: orgId, name: "REST Issues Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });

    const ctx = { userId, organizationId: orgId };
    // Letters only: the issue-key parser (here and in search.ts /
    // docs $pageId.tsx) matches /^([a-zA-Z]+)-(\d+)$/ — an established
    // convention across the codebase, not something to special-case here.
    projectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: projectKey, name: "REST Test", actorUserId: userId }));

    const auth = await getAuth();
    const created = await auth.api.createApiKey({
      body: { userId, permissions: { issues: ["read", "write"] }, metadata: { organizationId: orgId } },
    });
    token = created.key;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await issuesHandlers.GET({ request: req(`http://x/api/v1/issues?projectKey=${projectKey}`), params: {} });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("creates an issue, defaulting type/status, and lists it back", async () => {
    const createRes = await issuesHandlers.POST({
      request: req("http://x/api/v1/issues", { method: "POST", token, body: { projectKey, title: "First issue via REST" } }),
      params: {},
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.key).toBe(`${projectKey.toUpperCase()}-1`);

    const listRes = await issuesHandlers.GET({
      request: req(`http://x/api/v1/issues?projectKey=${projectKey}`, { token }),
      params: {},
    });
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].title).toBe("First issue via REST");

    const [dbIssue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, created.id));
    expect(dbIssue?.origin).toBe("api");
  });

  it("de-dupes a create with the same Idempotency-Key instead of making two issues", async () => {
    const body = { projectKey, title: "Idempotent issue" };
    const first = await issuesHandlers.POST({
      request: req("http://x/api/v1/issues", { method: "POST", token, body, idempotencyKey: "retry-1" }),
      params: {},
    });
    const second = await issuesHandlers.POST({
      request: req("http://x/api/v1/issues", { method: "POST", token, body, idempotencyKey: "retry-1" }),
      params: {},
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await first.json()).key).toBe((await second.json()).key);

    const listRes = await issuesHandlers.GET({
      request: req(`http://x/api/v1/issues?projectKey=${projectKey}`, { token }),
      params: {},
    });
    expect((await listRes.json()).data).toHaveLength(1);
  });

  it("rejects a create from a read-only-scoped token", async () => {
    const auth = await getAuth();
    const readOnly = await auth.api.createApiKey({
      body: { userId, permissions: { issues: ["read"] }, metadata: { organizationId: orgId } },
    });

    const res = await issuesHandlers.POST({
      request: req("http://x/api/v1/issues", { method: "POST", token: readOnly.key, body: { projectKey, title: "nope" } }),
      params: {},
    });
    expect(res.status).toBe(401);
  });

  it("gets, updates, transitions, and comments on an issue by its key", async () => {
    const created = await (
      await issuesHandlers.POST({
        request: req("http://x/api/v1/issues", { method: "POST", token, body: { projectKey, title: "Lifecycle issue" } }),
        params: {},
      })
    ).json();
    const issueKey: string = created.key;

    const getRes = await issueItemHandlers.GET({ request: req(`http://x/api/v1/issues/${issueKey}`, { token }), params: { issueKey } });
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).title).toBe("Lifecycle issue");

    const patchRes = await issueItemHandlers.PATCH({
      request: req(`http://x/api/v1/issues/${issueKey}`, { method: "PATCH", token, body: { priority: "highest" } }),
      params: { issueKey },
    });
    expect(patchRes.status).toBe(200);

    const [afterPatch] = await admin.select().from(schema.issue).where(eq(schema.issue.id, created.id));
    expect(afterPatch?.priority).toBe("highest");

    const transitionRes = await transitionHandlers.POST({
      request: req(`http://x/api/v1/issues/${issueKey}/transition`, { method: "POST", token, body: { status: "Done" } }),
      params: { issueKey },
    });
    expect(transitionRes.status).toBe(200);

    const commentRes = await commentsHandlers.POST({
      request: req(`http://x/api/v1/issues/${issueKey}/comments`, { method: "POST", token, body: { text: "via REST" } }),
      params: { issueKey },
    });
    expect(commentRes.status).toBe(201);

    const listCommentsRes = await commentsHandlers.GET({
      request: req(`http://x/api/v1/issues/${issueKey}/comments`, { token }),
      params: { issueKey },
    });
    const comments = await listCommentsRes.json();
    expect(comments.data).toHaveLength(1);
    expect(comments.data[0].text).toBe("via REST");
  });

  it("returns a 404 problem+json for an issue key that doesn't exist", async () => {
    const res = await issueItemHandlers.GET({
      request: req(`http://x/api/v1/issues/${projectKey.toUpperCase()}-999`, { token }),
      params: { issueKey: `${projectKey}-999` },
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.title).toBe("Not Found");
  });
});
