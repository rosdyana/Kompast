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

/** A tool's JSON payload, failing the test with the tool's own message if it came back as an error. */
async function callOk(token: string, name: string, args: Record<string, unknown> = {}) {
  const { body } = await callTool(token, name, args);
  if (!body.result) throw new Error(`${name} failed: ${JSON.stringify(body.error)}`);
  if (body.result.isError) throw new Error(`${name} failed: ${body.result.content[0].text}`);
  return JSON.parse(body.result.content[0].text);
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
    // The fixture user must belong to the team that owns the project, or
    // team-scoped RLS (packages/db/rls.sql) hides it from them.
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });

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

  it("accepts an arbitrary priority string beyond the old fixed enum", async () => {
    const create = await callTool(token, "create_issue", { projectKey, title: "MCP custom priority", priority: "blocker" });
    const created = JSON.parse(create.body.result.content[0].text);

    const [dbIssue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, created.id));
    expect(dbIssue?.priority).toBe("blocker");
  });

  it("comment_issue supports parentCommentId for threaded replies", async () => {
    const create = await callTool(token, "create_issue", { projectKey, title: "MCP threaded comments" });
    const created = JSON.parse(create.body.result.content[0].text);

    const parent = JSON.parse((await callTool(token, "comment_issue", { issueKey: created.key, text: "parent via mcp" })).body.result.content[0].text);
    const reply = JSON.parse(
      (await callTool(token, "comment_issue", { issueKey: created.key, text: "reply via mcp", parentCommentId: parent.id })).body.result.content[0].text,
    );

    const [dbReply] = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.id, reply.id));
    expect(dbReply?.parentCommentId).toBe(parent.id);
    expect(dbReply?.depth).toBe(1);
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
        "get_project",
        "list_teams",
        "list_issue_comments",
        "set_issue_property",
        "link_issues",
        "log_work",
        "list_worklogs",
        "list_attachments",
        "add_checklist_item",
        "update_checklist_item",
        "watch_issue",
        "archive_issue",
        "list_backlog",
        "create_sprint",
        "rename_sprint",
        "list_sprint_issues",
        "move_issue_to_sprint",
        "get_sprint_charts",
        "get_velocity",
        "search_pages",
        "list_page_comments",
        "resolve_page_comment",
        "get_page_links",
        "unlink_page_from_issue",
        "move_page",
        "duplicate_page",
        "list_templates",
        "set_page_template",
        "archive_page",
        "list_trash",
        "delete_page_permanently",
        "list_page_versions",
        "get_page_version",
        "favorite_page",
        "list_automations",
        "get_automation",
        "save_automation",
        "delete_automation",
        "list_automation_runs",
        "list_notifications",
        "mark_notifications_read",
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


  it("get_project lists what an issue can be filed with", async () => {
    const project = await callOk(token, "get_project", { projectKey });
    expect(project.key).toBe(projectKey.toUpperCase());
    expect(project.issueTypes.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["Epic", "Story"]));
    expect(project.statuses.map((s: { name: string }) => s.name)).toContain("In Progress");
    expect(project.members.map((m: { userId: string }) => m.userId)).toContain(userId);
  });

  it("creates an issue under an epic and in a sprint, then filters list_issues by them", async () => {
    const epic = await callOk(token, "create_issue", { projectKey, title: "Filter epic", type: "Epic" });
    const sprint = await callOk(token, "create_sprint", { projectKey, name: "Filter sprint" });
    const story = await callOk(token, "create_issue", {
      projectKey,
      title: "Filtered story",
      type: "Story",
      epicKey: epic.key,
      sprintId: sprint.sprintId,
      labels: ["mcp-label"],
      description: "Plain text body",
    });
    await callOk(token, "create_issue", { projectKey, title: "Unfiltered story" });

    const issue = await callOk(token, "get_issue", { issueKey: story.key });
    expect(issue).toMatchObject({ epicKey: epic.key, sprintId: sprint.sprintId, type: "Story", description: "Plain text body", archived: false });

    const bySprint = await callOk(token, "list_issues", { projectKey, sprintId: sprint.sprintId });
    expect(bySprint.data.map((i: { key: string }) => i.key)).toEqual([story.key]);
    const byEpic = await callOk(token, "list_issues", { projectKey, epicKey: epic.key });
    expect(byEpic.data.map((i: { key: string }) => i.key)).toEqual([story.key]);
    const byLabel = await callOk(token, "list_issues", { projectKey, label: "mcp-label" });
    expect(byLabel.data.map((i: { key: string }) => i.key)).toEqual([story.key]);

    const sprintIssues = await callOk(token, "list_sprint_issues", { sprintId: sprint.sprintId });
    expect(sprintIssues.map((i: { key: string }) => i.key)).toEqual([story.key]);

    await callOk(token, "move_issue_to_sprint", { issueKey: story.key });
    expect(await callOk(token, "list_sprint_issues", { sprintId: sprint.sprintId })).toEqual([]);
    const backlog = await callOk(token, "list_backlog", { projectKey });
    expect(backlog.map((i: { key: string }) => i.key)).toContain(story.key);
  });

  it("covers an issue's links, worklog, checklist, watching and comments", async () => {
    const a = await callOk(token, "create_issue", { projectKey, title: "Blocker" });
    const b = await callOk(token, "create_issue", { projectKey, title: "Blocked" });

    await callOk(token, "link_issues", { fromIssueKey: a.key, toIssueKey: b.key, type: "blocks" });
    await callOk(token, "log_work", { issueKey: a.key, seconds: 1800, note: "pairing" });
    const item = await callOk(token, "add_checklist_item", { issueKey: a.key, text: "write tests" });
    await callOk(token, "update_checklist_item", { issueKey: a.key, itemId: item.itemId ?? item.id, done: true });
    await callOk(token, "watch_issue", { issueKey: a.key, watching: true });
    await callOk(token, "comment_issue", { issueKey: a.key, text: "a comment" });

    const issue = await callOk(token, "get_issue", { issueKey: a.key });
    expect(issue.issueLinks).toEqual([expect.objectContaining({ type: "blocks", direction: "outward", issueKey: b.key })]);
    expect(issue.spentSeconds).toBe(1800);
    expect(issue.checklist).toEqual([expect.objectContaining({ text: "write tests", done: true })]);
    expect(issue.watcherIds).toContain(userId);

    const inward = await callOk(token, "get_issue", { issueKey: b.key });
    expect(inward.issueLinks).toEqual([expect.objectContaining({ direction: "inward", issueKey: a.key })]);

    const worklogs = await callOk(token, "list_worklogs", { issueKey: a.key });
    expect(worklogs).toEqual([expect.objectContaining({ seconds: 1800, note: "pairing", userId })]);
    const comments = await callOk(token, "list_issue_comments", { issueKey: a.key });
    expect(comments.map((c: { text: string }) => c.text)).toEqual(["a comment"]);

    await callOk(token, "update_checklist_item", { issueKey: a.key, itemId: item.itemId ?? item.id, delete: true });
    expect((await callOk(token, "get_issue", { issueKey: a.key })).checklist).toEqual([]);
  });

  it("archive_issue is refused for a plain team member, as in the UI", async () => {
    const created = await callOk(token, "create_issue", { projectKey, title: "Not mine to archive" });
    // createProject made the fixture user the project's lead; drop that so they're an ordinary member.
    await admin.delete(schema.projectMember).where(eq(schema.projectMember.userId, userId));
    const res = await callTool(token, "archive_issue", { issueKey: created.key });
    expect(res.body.result.isError).toBe(true);

    await admin.update(schema.teamMember).set({ role: "admin" }).where(eq(schema.teamMember.teamId, teamId));
    await callOk(token, "archive_issue", { issueKey: created.key });
    expect((await callOk(token, "get_issue", { issueKey: created.key })).archived).toBe(true);
    const listed = await callOk(token, "list_issues", { projectKey });
    expect(listed.data.map((i: { key: string }) => i.key)).not.toContain(created.key);
    await callOk(token, "archive_issue", { issueKey: created.key, restore: true });
    expect((await callOk(token, "get_issue", { issueKey: created.key })).archived).toBe(false);
  });

  it("reads sprint charts and velocity, and renames a sprint", async () => {
    const sprint = await callOk(token, "create_sprint", { projectKey, name: "Charts sprint" });
    await callOk(token, "rename_sprint", { sprintId: sprint.sprintId, name: "Renamed sprint" });
    expect((await callOk(token, "get_sprint", { sprintId: sprint.sprintId })).name).toBe("Renamed sprint");

    const charts = await callOk(token, "get_sprint_charts", { sprintId: sprint.sprintId });
    expect(charts).toHaveProperty("burndown");
    expect(charts).toHaveProperty("cumulativeFlow");
    expect(Array.isArray(await callOk(token, "get_velocity", { projectKey }))).toBe(true);
  });

  it("create_sprint needs sprints:write", async () => {
    const res = await callTool(readOnlyToken, "create_sprint", { projectKey });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain("sprints:write");
  });

  it("moves, duplicates, trashes, restores and deletes pages", async () => {
    const parent = await callOk(token, "create_page", { title: "MCP parent" });
    const child = await callOk(token, "create_page", { title: "MCP child", content: "child body" });

    await callOk(token, "move_page", { pageId: child.id, parentPageId: parent.id });
    expect((await callOk(token, "get_page", { pageId: child.id })).parentPageId).toBe(parent.id);

    const found = await callOk(token, "search_pages", { query: "MCP chi" });
    expect(found.data.map((p: { id: string }) => p.id)).toEqual([child.id]);

    const copy = await callOk(token, "duplicate_page", { pageId: child.id });
    expect(copy.title).toBe("MCP child (copy)");
    expect((await callOk(token, "get_page", { pageId: copy.id })).content).toContain("child body");

    await callOk(token, "move_page", { pageId: copy.id, private: true });
    expect((await callOk(token, "get_page", { pageId: copy.id })).private).toBe(true);

    await callOk(token, "archive_page", { pageId: parent.id });
    const trash = await callOk(token, "list_trash");
    expect(trash.data.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining([parent.id, child.id]));

    await callOk(token, "archive_page", { pageId: parent.id, restore: true });
    expect((await callOk(token, "list_trash")).data.map((p: { id: string }) => p.id)).not.toContain(parent.id);

    const notTrashed = await callTool(token, "delete_page_permanently", { pageId: copy.id });
    expect(notTrashed.body.result.isError).toBe(true);
    await callOk(token, "archive_page", { pageId: copy.id });
    await callOk(token, "delete_page_permanently", { pageId: copy.id });
    const gone = await callTool(token, "get_page", { pageId: copy.id });
    expect(gone.body.result.isError).toBe(true);
  });

  it("refuses to duplicate a restricted page for someone who can't manage its access", async () => {
    const otherId = "test-mcp-other-user";
    await admin.delete(schema.member).where(eq(schema.member.userId, otherId));
    await admin.delete(schema.user).where(eq(schema.user.id, otherId));
    await admin.insert(schema.user).values({ id: otherId, name: "Other", email: `${otherId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId: otherId, role: "member" });
    try {
      const page = await callOk(token, "create_page", { title: "Restricted" });
      await callOk(token, "set_page_access", { pageId: page.id, subjectType: "user", subjectId: otherId, role: "view" });

      const auth = await getAuth();
      const otherToken = (await auth.api.createApiKey({ body: { userId: otherId, permissions: { pages: ["read", "write"] }, metadata: { organizationId: orgId } } })).key;
      expect((await callOk(otherToken, "get_page", { pageId: page.id })).title).toBe("Restricted");
      const res = await callTool(otherToken, "duplicate_page", { pageId: page.id });
      expect(res.body.result.isError).toBe(true);
      expect(res.body.result.content[0].text).toContain("restricted");
    } finally {
      await admin.delete(schema.pagePermission).where(eq(schema.pagePermission.subjectId, otherId));
      await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, otherId));
      await admin.delete(schema.member).where(eq(schema.member.userId, otherId));
      await admin.delete(schema.user).where(eq(schema.user.id, otherId));
    }
  });

  it("covers page comments, links, templates, versions and favorites", async () => {
    const page = await callOk(token, "create_page", { title: "MCP extras" });
    const issue = await callOk(token, "create_issue", { projectKey, title: "Linked from extras" });

    const comment = await callOk(token, "comment_page", { pageId: page.id, text: "please review" });
    expect((await callOk(token, "list_page_comments", { pageId: page.id })).map((c: { text: string }) => c.text)).toEqual(["please review"]);
    await callOk(token, "resolve_page_comment", { pageId: page.id, commentId: comment.id });
    expect(await callOk(token, "list_page_comments", { pageId: page.id })).toEqual([]);

    await callOk(token, "link_page_to_issue", { pageId: page.id, issueKey: issue.key });
    expect((await callOk(token, "get_page_links", { pageId: page.id })).linkedIssues).toEqual([issue.key]);
    expect((await callOk(token, "get_issue", { issueKey: issue.key })).linkedPages).toEqual([{ id: page.id, title: "MCP extras" }]);
    await callOk(token, "unlink_page_from_issue", { pageId: page.id, issueKey: issue.key });
    expect((await callOk(token, "get_page_links", { pageId: page.id })).linkedIssues).toEqual([]);

    await callOk(token, "set_page_template", { pageId: page.id, isTemplate: true });
    expect((await callOk(token, "list_templates")).data.map((p: { id: string }) => p.id)).toContain(page.id);
    const fromTemplate = await callOk(token, "duplicate_page", { pageId: page.id });
    expect(fromTemplate).toMatchObject({ title: "MCP extras", type: "doc" });

    expect(await callOk(token, "list_page_versions", { pageId: page.id })).toEqual([]);
    const missing = await callTool(token, "get_page_version", { pageId: page.id, versionId: "nope" });
    expect(missing.body.result.isError).toBe(true);

    expect((await callOk(token, "favorite_page", { pageId: page.id, favorite: true })).favorite).toBe(true);
    await callOk(token, "favorite_page", { pageId: page.id, favorite: true });
    const [fav] = await admin.select().from(schema.pageFavorite).where(eq(schema.pageFavorite.pageId, page.id));
    expect(fav?.userId).toBe(userId);
  });

  it("creates, updates, inspects and deletes an automation workflow", async () => {
    const nodeId = `mcp-${Math.random().toString(36).slice(2)}`;
    const trigger = { id: nodeId, type: "trigger_event", config: {}, position: { x: 0, y: 0 } };
    const created = await callOk(token, "save_automation", { projectKey, name: "MCP rule", nodes: [trigger], edges: [] });
    expect(created.workflowId).toBeTruthy();

    const bad = await callTool(token, "save_automation", { projectKey, workflowId: created.workflowId, nodes: [trigger] });
    expect(bad.body.result.isError).toBe(true);

    await callOk(token, "save_automation", { projectKey, workflowId: created.workflowId, name: "MCP rule v2", enabled: false });
    const workflows = await callOk(token, "list_automations", { projectKey });
    expect(workflows).toEqual([expect.objectContaining({ id: created.workflowId, name: "MCP rule v2", enabled: false })]);
    expect((await callOk(token, "get_automation", { projectKey, workflowId: created.workflowId })).nodes).toHaveLength(1);
    expect(await callOk(token, "list_automation_runs", { projectKey, workflowId: created.workflowId })).toEqual([]);

    await callOk(token, "delete_automation", { projectKey, workflowId: created.workflowId });
    expect(await callOk(token, "list_automations", { projectKey })).toEqual([]);
  });

  it("lists teams and the caller's notifications", async () => {
    const teams = await callOk(token, "list_teams");
    expect(teams.map((t: { id: string }) => t.id)).toContain(teamId);
    expect(await callOk(token, "list_notifications", { unreadOnly: true })).toEqual([]);
    expect((await callOk(token, "mark_notifications_read")).ok).toBe(true);
  });
});
