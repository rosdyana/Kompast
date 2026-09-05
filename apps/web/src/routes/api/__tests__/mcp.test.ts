import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { createProject, createSprint, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { getAuth } from "../../../lib/auth";
import { Route as McpRoute } from "../mcp";

type Handler = (opts: { request: Request; params: Record<string, string> }) => Promise<Response>;
const mcpHandlers = McpRoute.options.server!.handlers as { POST: Handler; GET: Handler; DELETE: Handler };

function rpcReq(token: string | undefined, body: unknown) {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://x/api/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await mcpHandlers.POST({
    request: rpcReq(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    params: {},
  });
  const body = await res.json();
  return { status: res.status, body };
}

describe("/api/mcp", () => {
  const orgId = "test-mcp-org";
  const userId = "test-mcp-user";
  const teamId = "test-mcp-team";
  let token: string;
  let readOnlyToken: string;
  let projectKey: string;
  let boardId: string;

  async function cleanup() {
    await admin.delete(schema.link).where(eq(schema.link.organizationId, orgId));
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
    await admin.insert(schema.organization).values({ id: orgId, name: "MCP Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });

    projectKey = Array.from({ length: 5 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    const project = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: projectKey, name: "MCP Test", actorUserId: userId }),
    );
    boardId = project.boardId;

    const auth = await getAuth();
    const created = await auth.api.createApiKey({
      body: { userId, permissions: { issues: ["read", "write"], pages: ["read", "write"], sprints: ["write"] }, metadata: { organizationId: orgId } },
    });
    token = created.key;

    const readOnly = await auth.api.createApiKey({ body: { userId, permissions: { issues: ["read"] }, metadata: { organizationId: orgId } } });
    readOnlyToken = readOnly.key;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await mcpHandlers.POST({ request: rpcReq(undefined, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }), params: {} });
    expect(res.status).toBe(401);
  });

  it("405s GET and DELETE — this endpoint is POST-only stateless", async () => {
    expect((await mcpHandlers.GET({ request: new Request("http://x/api/mcp"), params: {} })).status).toBe(405);
    expect((await mcpHandlers.DELETE({ request: new Request("http://x/api/mcp", { method: "DELETE" }), params: {} })).status).toBe(405);
  });

  it("whoami reflects the authenticated token's identity", async () => {
    const { status, body } = await callTool(token, "whoami", {});
    expect(status).toBe(200);
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.userId).toBe(userId);
    expect(payload.organizationId).toBe(orgId);
  });

  it("creates an issue via create_issue and reads it back via get_issue", async () => {
    const create = await callTool(token, "create_issue", { projectKey, title: "MCP created issue" });
    const created = JSON.parse(create.body.result.content[0].text);
    expect(created.key).toMatch(new RegExp(`^${projectKey.toUpperCase()}-\\d+$`));

    const get = await callTool(token, "get_issue", { issueKey: created.key });
    const issue = JSON.parse(get.body.result.content[0].text);
    expect(issue.title).toBe("MCP created issue");
  });

  it("transitions and comments on an issue, attributing origin=mcp", async () => {
    const create = await callTool(token, "create_issue", { projectKey, title: "To transition" });
    const created = JSON.parse(create.body.result.content[0].text);

    const transition = await callTool(token, "transition_issue", { issueKey: created.key, status: "In Progress" });
    expect(JSON.parse(transition.body.result.content[0].text).ok).toBe(true);

    const comment = await callTool(token, "comment_issue", { issueKey: created.key, text: "Working on it via Claude Code" });
    expect(JSON.parse(comment.body.result.content[0].text).id).toBeTruthy();

    const [historyRow] = await admin
      .select()
      .from(schema.issueHistory)
      .where(eq(schema.issueHistory.issueId, (await admin.select().from(schema.issue).where(eq(schema.issue.title, "To transition")))[0]!.id));
    expect(historyRow?.origin).toBe("mcp");
  });

  it("returns a tool-level error (not an HTTP error) when the token lacks the required scope", async () => {
    const { status, body } = await callTool(readOnlyToken, "create_issue", { projectKey, title: "Should fail" });
    expect(status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("issues:write");
  });

  it("creates a page with initial content and reads it back as markdown", async () => {
    const create = await callTool(token, "create_page", { title: "MCP doc", content: "# Hello from MCP" });
    const page = JSON.parse(create.body.result.content[0].text);

    const get = await callTool(token, "get_page", { pageId: page.id });
    const fetched = JSON.parse(get.body.result.content[0].text);
    expect(fetched.content).toContain("Hello from MCP");
  });

  it("links a page to an issue via link_page_to_issue", async () => {
    const page = JSON.parse((await callTool(token, "create_page", { title: "Linked doc" })).body.result.content[0].text);
    const issue = JSON.parse((await callTool(token, "create_issue", { projectKey, title: "Linked issue" })).body.result.content[0].text);

    const link = await callTool(token, "link_page_to_issue", { pageId: page.id, issueKey: issue.key });
    expect(JSON.parse(link.body.result.content[0].text).ok).toBe(true);
  });

  it("reads an issue resource by kompast://issue/{key} URI", async () => {
    const created = JSON.parse((await callTool(token, "create_issue", { projectKey, title: "Resource issue" })).body.result.content[0].text);
    const res = await mcpHandlers.POST({
      request: rpcReq(token, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: `kompast://issue/${created.key}` } }),
      params: {},
    });
    const body = await res.json();
    const data = JSON.parse(body.result.contents[0].text);
    expect(data.title).toBe("Resource issue");
  });

  it("lists all registered tools with no schema registration errors", async () => {
    const res = await mcpHandlers.POST({
      request: rpcReq(token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      params: {},
    });
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "whoami",
        "search",
        "create_issue",
        "update_issue",
        "transition_issue",
        "assign_issue",
        "comment_issue",
        "link_issue",
        "create_page",
        "update_page",
        "comment_page",
        "link_page_to_issue",
      ]),
    );
  });

  it("generates a standup-digest prompt from the caller's recently-updated issues", async () => {
    await callTool(token, "create_issue", { projectKey, title: "Assigned to me", assigneeEmail: `${userId}@example.com` });
    const res = await mcpHandlers.POST({
      request: rpcReq(token, { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "standup-digest" } }),
      params: {},
    });
    const body = await res.json();
    expect(body.result.messages[0].content.text).toContain("Assigned to me");
  });

  it("lists, starts, and completes a sprint via list_sprints/get_sprint/start_sprint/complete_sprint", async () => {
    const { sprintId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createSprint(tx, { organizationId: orgId, boardId, name: "MCP Sprint" }),
    );

    const list = JSON.parse((await callTool(token, "list_sprints", { projectKey })).body.result.content[0].text);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(sprintId);

    const started = await callTool(token, "start_sprint", { sprintId });
    expect(JSON.parse(started.body.result.content[0].text).ok).toBe(true);

    const got = JSON.parse((await callTool(token, "get_sprint", { sprintId })).body.result.content[0].text);
    expect(got.state).toBe("active");

    const completed = await callTool(token, "complete_sprint", { sprintId });
    expect(completed.status).toBe(200);
    expect(JSON.parse(completed.body.result.content[0].text).velocity).toBe(0);
  });

  it("returns a tool-level error when starting a sprint without sprints:write", async () => {
    const { sprintId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createSprint(tx, { organizationId: orgId, boardId, name: "MCP Sprint 2" }),
    );
    const res = await callTool(readOnlyToken, "start_sprint", { sprintId });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain("sprints:write");
  });

  it("links an issue to an epic via update_issue's epicKey and get_roadmap reflects it", async () => {
    const epic = JSON.parse((await callTool(token, "create_issue", { projectKey, title: "Epic via MCP", type: "Epic" })).body.result.content[0].text);
    const story = JSON.parse((await callTool(token, "create_issue", { projectKey, title: "Story via MCP", type: "Story" })).body.result.content[0].text);

    const updated = await callTool(token, "update_issue", { issueKey: story.key, epicKey: epic.key });
    expect(JSON.parse(updated.body.result.content[0].text).ok).toBe(true);

    const roadmap = JSON.parse((await callTool(token, "get_roadmap", { projectKey })).body.result.content[0].text);
    expect(roadmap).toEqual([{ key: epic.key, title: "Epic via MCP", startDate: null, dueDate: null, childCount: 1, doneCount: 0 }]);
  });
});
