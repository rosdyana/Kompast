import { describe, expect, it, vi } from "vitest";
import { createJiraClient } from "../jira/client";
import { discoverJiraProject } from "../jira/discover";

const creds = { baseUrl: "https://demo.atlassian.net", email: "me@example.com", apiToken: "tok" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const alice = { accountId: "acc-alice", displayName: "Alice Dev", emailAddress: "alice@example.com", active: true, accountType: "atlassian" };
const bob = { accountId: "acc-bob", displayName: "Bob", active: false, accountType: "atlassian" };

const sprintField = (...sprints: { id: number; name: string; state: string }[]) => sprints;

const issues = {
  "DEMO-1": {
    id: "1",
    key: "DEMO-1",
    fields: {
      summary: "One",
      reporter: alice,
      creator: alice,
      assignee: alice,
      labels: [],
      attachment: [{ size: 100 }, { size: 2048 }],
      comment: { total: 3, comments: [{ author: bob }] },
      worklog: { total: 2, worklogs: [] },
      customfield_10020: sprintField({ id: 2, name: "Sprint 2", state: "active" }),
      created: "2024-01-01T00:00:00.000+0000",
    },
  },
  "DEMO-2": {
    id: "2",
    key: "DEMO-2",
    fields: {
      summary: "Two",
      reporter: bob,
      creator: bob,
      assignee: alice,
      labels: ["x"],
      attachment: [],
      comment: { total: 0, comments: [] },
      worklog: { total: 0, worklogs: [] },
      customfield_10020: sprintField({ id: 1, name: "Sprint 1", state: "closed" }),
      created: "2024-01-02T00:00:00.000+0000",
    },
  },
  "DEMO-3": {
    id: "3",
    key: "DEMO-3",
    fields: {
      summary: "Three",
      reporter: alice,
      creator: alice,
      assignee: null,
      labels: [],
      attachment: [],
      customfield_10020: null,
      created: "2024-01-03T00:00:00.000+0000",
    },
  },
};

interface RouteOptions {
  boards?: { id: number; name: string; type: string }[];
  /** When set, the board sprint endpoint answers with this status instead of the sprint list. */
  sprintEndpointStatus?: number;
}

/** A fake JIRA: answers each endpoint from a table, 404s anything it doesn't know, and records the search calls it saw. */
function fakeJira(opts: RouteOptions = {}) {
  const boards = opts.boards ?? [{ id: 7, name: "Demo board", type: "scrum" }];
  const searchCalls: URL[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;

    if (path === "/rest/api/3/myself") return json({ accountId: "me", displayName: "Me", emailAddress: "me@example.com" });
    if (path === "/rest/api/3/project/DEMO") return json({ id: "10000", key: "DEMO", name: "Demo" });
    if (path === "/rest/agile/1.0/board") return json({ values: boards, isLast: true });
    if (path === "/rest/agile/1.0/board/7/sprint") {
      if (opts.sprintEndpointStatus) return new Response("not a scrum board", { status: opts.sprintEndpointStatus });
      return json({
        values: [
          { id: 1, name: "Sprint 1", state: "closed", startDate: "2024-01-01T00:00:00.000Z", endDate: "2024-01-14T00:00:00.000Z", completeDate: "2024-01-14T00:00:00.000Z", originBoardId: 7 },
          { id: 2, name: "Sprint 2", state: "active", startDate: "2024-01-15T00:00:00.000Z", endDate: "2024-01-28T00:00:00.000Z", originBoardId: 7 },
          { id: 3, name: "Sprint 3", state: "future", originBoardId: 7 },
        ],
        isLast: true,
      });
    }
    if (path === "/rest/api/3/project/DEMO/statuses") {
      return json([
        { name: "Task", subtask: false, statuses: [{ name: "To Do", statusCategory: { key: "new" } }, { name: "Done", statusCategory: { key: "done" } }] },
        { name: "Subtask", subtask: true, statuses: [{ name: "To Do", statusCategory: { key: "new" } }] },
      ]);
    }
    if (path === "/rest/api/3/priority") return json([{ name: "High" }, { name: "Low" }]);
    if (path === "/rest/api/3/field") {
      return json([
        { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
        { id: "customfield_10020", name: "Sprint", custom: true, schema: { type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
      ]);
    }
    if (path === "/rest/api/3/search/jql") {
      searchCalls.push(url);
      const token = url.searchParams.get("nextPageToken");
      if (!token) return json({ issues: [issues["DEMO-1"], issues["DEMO-2"]], nextPageToken: "page-2", isLast: false });
      return json({ issues: [issues["DEMO-3"]], isLast: true });
    }
    return new Response(`no route for ${path}`, { status: 404 });
  });
  return { fetchMock, searchCalls };
}

describe("discoverJiraProject", () => {
  it("surveys boards, sprints (including an empty future one), statuses, fields, and people from a two-page scan", async () => {
    const { fetchMock, searchCalls } = fakeJira();
    const client = createJiraClient(creds, { fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    const onProgress = vi.fn();

    const d = await discoverJiraProject(client, { projectKey: "DEMO", onProgress });

    expect(d.myself).toEqual({ accountId: "me", displayName: "Me", emailAddress: "me@example.com" });
    expect(d.project).toEqual({ id: "10000", key: "DEMO", name: "Demo" });
    expect(d.board).toEqual({ id: 7, name: "Demo board", type: "scrum" });

    // The empty future sprint comes only from the board endpoint.
    expect(d.sprints.map((s) => [s.id, s.state])).toEqual([
      [1, "closed"],
      [2, "active"],
      [3, "future"],
    ]);

    expect(d.statuses).toEqual([
      { name: "To Do", categoryKey: "new" },
      { name: "Done", categoryKey: "done" },
    ]);
    expect(d.issueTypes).toEqual([
      { name: "Task", subtask: false },
      { name: "Subtask", subtask: true },
    ]);
    expect(d.priorities).toEqual([{ name: "High" }, { name: "Low" }]);
    expect(d.fields.find((f) => f.id === "customfield_10020")).toMatchObject({ custom: true, schemaType: "array", schemaCustom: "com.pyxis.greenhopper.jira:gh-sprint" });

    // Scan: pages are followed, the JQL is project-scoped, and no changelog is requested.
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[0]!.searchParams.get("jql")).toBe('project = "DEMO" ORDER BY key ASC');
    expect(searchCalls[0]!.searchParams.get("fields")).toBe("*all");
    expect(searchCalls[0]!.searchParams.has("expand")).toBe(false);
    expect(searchCalls[1]!.searchParams.get("nextPageToken")).toBe("page-2");
    expect(onProgress).toHaveBeenLastCalledWith(3);

    expect(d.issueCount).toBe(3);
    expect(d.minKeyNumber).toBe(1);
    expect(d.maxKeyNumber).toBe(3);

    // Field usage: empty values (labels [], null sprint, null assignee) don't count.
    expect(d.fieldUsage.summary).toBe(3);
    expect(d.fieldUsage.assignee).toBe(2);
    expect(d.fieldUsage.customfield_10020).toBe(2);
    expect(d.fieldUsage.labels).toBe(1);

    expect(d.attachmentSizes).toEqual([100, 2048]);
    expect(d.attachmentCount).toBe(2);
    expect(d.commentCount).toBe(3);
    expect(d.worklogCount).toBe(2);

    // Alice touched all three issues; her last sprint is Sprint 2 (DEMO-1).
    const aliceRow = d.people.find((p) => p.accountId === "acc-alice");
    expect(aliceRow).toMatchObject({ displayName: "Alice Dev", emailAddress: "alice@example.com", active: true, touches: 3, lastSprintNumber: 2 });
    // Bob: a comment author on DEMO-1, reporter/creator on DEMO-2. Inactive, no email.
    const bobRow = d.people.find((p) => p.accountId === "acc-bob");
    expect(bobRow).toMatchObject({ displayName: "Bob", emailAddress: null, active: false, touches: 2, lastSprintNumber: 2 });
  });

  it("a kanban board never calls the sprint endpoint, and a scrum board that 400s on it does not crash", async () => {
    const kanban = fakeJira({ boards: [{ id: 7, name: "Demo board", type: "kanban" }] });
    const kanbanClient = createJiraClient(creds, { fetch: kanban.fetchMock as unknown as typeof fetch, sleep: async () => {} });
    const kd = await discoverJiraProject(kanbanClient, { projectKey: "DEMO" });
    expect(kd.board?.type).toBe("kanban");
    expect(kd.sprints.map((s) => s.id).sort()).toEqual([1, 2]); // from issues only, no empty future sprint
    expect(kanban.fetchMock.mock.calls.some((c) => String(c[0]).includes("/sprint"))).toBe(false);

    const scrum400 = fakeJira({ sprintEndpointStatus: 400 });
    const scrumClient = createJiraClient(creds, { fetch: scrum400.fetchMock as unknown as typeof fetch, sleep: async () => {} });
    const sd = await discoverJiraProject(scrumClient, { projectKey: "DEMO" });
    expect(sd.issueCount).toBe(3);
    expect(sd.sprints.map((s) => s.id).sort()).toEqual([1, 2]);
  });

  it("uses the requested board id instead of the first one", async () => {
    const { fetchMock } = fakeJira({
      boards: [
        { id: 6, name: "Other", type: "kanban" },
        { id: 7, name: "Demo board", type: "scrum" },
      ],
    });
    const client = createJiraClient(creds, { fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    const d = await discoverJiraProject(client, { projectKey: "DEMO", boardId: 7 });
    expect(d.board?.id).toBe(7);
    expect(d.sprints.map((s) => s.id)).toContain(3);
  });
});
