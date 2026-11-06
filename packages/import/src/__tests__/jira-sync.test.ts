import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, eq, and, asc, desc, adminDb as admin } from "@kompast/db";
import {
  createJiraMigration,
  createProject,
  getJiraMigration,
  requestJiraDiscovery,
  startJiraMigrationRun,
  updateIssue,
  withAuthorizedTenant,
  type JiraMigrationPublic,
} from "@kompast/core";
import { id } from "@kompast/core/ids";
import { createJiraClient } from "../jira/client";
import { startDueJiraAutoSyncs, runJiraMigrationTick } from "../jira/migration-runner";
import { changedSinceJql, jqlTimestampIn } from "../jira/sync";

/**
 * The catch-up sync end to end, against real Postgres with JIRA mocked behind the real client. Each test first runs a
 * full import, then edits the fake JIRA and syncs. One file, run in order, on its own org.
 */
describe("JIRA catch-up sync (real Postgres, mocked JIRA)", () => {
  const orgId = "test-jira-sync-org";
  const userId = "test-jira-sync-user";
  const teamId = "test-jira-sync-team";
  const ctx = { userId, organizationId: orgId };
  const creatorEmail = `${userId}@example.com`;

  let projectId: string;
  let boardId: string;
  let migrationId: string;
  let jira: ReturnType<typeof fakeJira>;

  async function cleanup() {
    await admin.delete(schema.jiraMigration).where(eq(schema.jiraMigration.organizationId, orgId));
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Sync Test Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Syncer", email: creatorEmail });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Sync Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });

    const project = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "jsync", name: "JIRA Sync", actorUserId: userId }));
    projectId = project.projectId;
    boardId = project.boardId;

    const created = await withAuthorizedTenant(ctx, (tx) =>
      createJiraMigration(tx, ctx, {
        projectId,
        boardId,
        siteUrl: "https://jira.example.net/",
        email: creatorEmail,
        apiToken: "jira-token-sync",
        jiraProjectKey: "JSYNC",
        jiraBoardId: 7,
      }),
    );
    migrationId = created.migrationId;
    jira = fakeJira();
  });

  afterAll(cleanup);

  function deps() {
    return {
      adminDb: admin,
      withTenantAs: withAuthorizedTenant,
      createClient: (creds: Parameters<typeof createJiraClient>[0]) =>
        createJiraClient(creds, { fetch: jira.fetchMock as unknown as typeof fetch, sleep: async () => {} }),
      timeBudgetMs: 60_000,
    };
  }

  async function current(): Promise<JiraMigrationPublic> {
    const row = await withAuthorizedTenant(ctx, (tx) => getJiraMigration(tx, migrationId));
    if (!row) throw new Error("migration not visible");
    return row;
  }

  /** Ticks the migration until it leaves running (or the state changes), bounded. */
  async function tickToEnd(): Promise<JiraMigrationPublic> {
    for (let i = 0; i < 10; i++) {
      const m = await current();
      if (m.state !== "running" && m.state !== "discovering") return m;
      await runJiraMigrationTick(deps(), m);
    }
    throw new Error("the migration did not finish");
  }

  /** A full import of the fake project, to start from. */
  async function fullImport() {
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));
    await runJiraMigrationTick(deps(), await current());
    await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));
    const m = await tickToEnd();
    expect(m.state).toBe("synced");
  }

  async function startSync(): Promise<string> {
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));
    const m = await tickToEnd();
    expect(m.state).toBe("synced");
    return importRunId;
  }

  async function runCounts(importRunId: string) {
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    return { run: run!, counts: run!.counts as Record<string, number> };
  }

  async function issueByKey(key: string) {
    const [ref] = await admin
      .select()
      .from(schema.externalRef)
      .where(and(eq(schema.externalRef.organizationId, orgId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.sourceId, key)));
    if (!ref) return null;
    const [row] = await admin.select().from(schema.issue).where(eq(schema.issue.id, ref.entityId));
    return row ?? null;
  }

  it("the JQL for a sync reads changes from the last sync, less ten minutes, in the account's time zone", async () => {
    await fullImport();
    const m = await current();
    const jql = jira.state.jqls.find((q) => q.includes("updated >="));
    expect(jql).toBeUndefined(); // the full import reads the whole project, not a window

    await startSync();
    const syncJql = jira.state.jqls.find((q) => q.includes("updated >="));
    const since = new Date(new Date(m.lastSyncedAt!).getTime() - 10 * 60_000);
    expect(syncJql).toBe(changedSinceJql("JSYNC", since, "Asia/Taipei"));
    expect(syncJql).toContain(`updated >= "${jqlTimestampIn(since, "Asia/Taipei")}"`);
  });

  it("a sync after a full import: edits, comments, worklogs, changelog, sprint moves, a new issue, an attachment; a second identical sync changes nothing", async () => {
    await fullImport();
    const before = await issueByKey("JSYNC-1");
    expect(before?.title).toBe("Child story");

    // JIRA moves on: a summary and an assignee edit, a comment edit and a new comment, a new worklog, a new
    // attachment, a new status, a sprint move, and a new issue.
    jira.edit("JSYNC-1", (i) => {
      i.fields.summary = "Child story renamed";
      i.fields.assignee = importer;
      i.fields.updated = nowSync();
      i.changelog.histories.push({ id: "h-1", created: nowSync(), author: importer, items: [item("summary", "Child story", "Child story renamed"), item("assignee", null, "Importer", "acc-importer", null)] });
      i.fields.comment!.comments[0]!.body = adfText("first, edited");
      i.fields.comment!.comments[0]!.updated = nowSync();
      i.fields.comment!.comments.push({ id: "c-2", author: importer, body: adfText("second"), created: nowSync(), updated: nowSync() });
      i.fields.comment!.total = 2;
      i.fields.worklog!.worklogs.push({ id: "w-2", author: importer, timeSpentSeconds: 1800, started: nowSync() });
      i.fields.worklog!.total = 2;
      i.fields.attachment = [{ id: "att-1", filename: "big.bin", mimeType: "application/octet-stream", size: 20 * 1024 * 1024, content: "https://jira.example.net/rest/api/3/attachment/content/att-1", created: nowSync(), author: importer }];
    });
    jira.edit("JSYNC-3", (i) => {
      i.fields.status = { name: "Blocked", statusCategory: { key: "indeterminate", name: "Blocked" } };
      i.fields.customfield_10020 = [SPRINT_3];
      i.fields.updated = nowSync();
      i.changelog.histories.push({
        id: "h-3",
        created: nowSync(),
        author: importer,
        items: [item("status", "To Do", "Blocked", "new", "indeterminate"), item("Sprint", "2", "3", "Sprint 2", "Sprint 3")],
      });
    });
    jira.addIssue(newIssue("JSYNC-5", "Brand new", nowSync()));
    // JIRA gained a status: the project's status list has it now.
    jira.state.statuses.push({ name: "Blocked", statusCategory: { key: "indeterminate" } } as (typeof jira.state.statuses)[number]);
    jira.state.changedKeys = ["JSYNC-1", "JSYNC-3", "JSYNC-5"];

    const runId = await startSync();
    const { counts } = await runCounts(runId);
    expect(counts).toMatchObject({
      issuesCreated: 1,
      issuesUpdated: 2,
      issuesUnchanged: 0,
      commentsAdded: 1,
      commentsUpdated: 1,
      worklogsAdded: 1,
      worklogsUpdated: 0,
      historyEntriesRecorded: 4,
      linksCreated: 0,
      watchersAdded: 0,
      attachmentsQueued: 0,
      sprintsCreated: 0,
      sprintsStarted: 0,
      sprintsCompleted: 0,
    });

    const one = await issueByKey("JSYNC-1");
    expect(one?.title).toBe("Child story renamed");
    expect(one?.assigneeId).toBe(userId);
    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, one!.id)).orderBy(asc(schema.issueComment.createdAt));
    expect(comments).toHaveLength(2);
    expect(comments.map((c) => JSON.stringify(c.bodyJson).includes("first, edited"))).toEqual([true, false]);
    const worklogs = await admin.select().from(schema.worklog).where(eq(schema.worklog.issueId, one!.id));
    expect(worklogs).toHaveLength(2);
    expect(one?.spentSeconds).toBe(3600 + 1800);

    // The changelog entries are recorded once each, not twice.
    const titleRows = await admin.select().from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, one!.id), eq(schema.issueHistory.field, "title")));
    expect(titleRows.filter((r) => r.toValue === "Child story renamed")).toHaveLength(1);

    // The attachment is not copied (over the limit): a placeholder, not pending.
    const attachments = await admin.select().from(schema.issueAttachment).where(eq(schema.issueAttachment.issueId, one!.id));
    expect(attachments).toEqual([expect.objectContaining({ fileName: "big.bin", status: "not_migrated" })]);

    // The status is created and used, and the issue moved to Sprint 3.
    const three = await issueByKey("JSYNC-3");
    const statuses = await admin.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId));
    expect(statuses.map((s) => s.name)).toContain("Blocked");
    expect(statuses.find((s) => s.id === three?.statusId)?.name).toBe("Blocked");
    const sprints = await admin.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId));
    expect(sprints.find((s) => s.id === three?.sprintId)?.name).toBe("Sprint 3");
    const memberships = await admin.select().from(schema.sprintIssue).where(eq(schema.sprintIssue.issueId, three!.id));
    expect(memberships.filter((m) => m.removedAt === null).map((m) => sprints.find((s) => s.id === m.sprintId)?.name)).toEqual(["Sprint 3"]);

    const created = await issueByKey("JSYNC-5");
    expect(created?.title).toBe("Brand new");
    expect(created?.origin).toBe("import");

    // A second identical sync: the same window is read again, and nothing changes.
    const second = await startSync();
    const again = await runCounts(second);
    expect(again.counts).toMatchObject({
      issuesCreated: 0,
      issuesUpdated: 0,
      issuesUnchanged: 3,
      commentsAdded: 0,
      commentsUpdated: 0,
      worklogsAdded: 0,
      worklogsUpdated: 0,
      historyEntriesRecorded: 0,
      linksCreated: 0,
      watchersAdded: 0,
      attachmentsQueued: 0,
    });
    expect(again.run.notes).toMatchObject({ newStatuses: [], conflicts: [], deletedInJira: [], movedInJira: [] });
    const titleRowsAfter = await admin.select().from(schema.issueHistory).where(and(eq(schema.issueHistory.issueId, one!.id), eq(schema.issueHistory.field, "title")));
    expect(titleRowsAfter.filter((r) => r.toValue === "Child story renamed")).toHaveLength(1);
  });

  it("a sprint JIRA closed is completed, the next future sprint JIRA started is started, and a new future sprint is created", async () => {
    await fullImport();
    // Sprint 2 is closed in JIRA, Sprint 3 is started, and a Sprint 4 is planned.
    jira.state.sprints = [
      { ...SPRINT_1 },
      { ...SPRINT_2, state: "closed", completeDate: "2026-02-01T00:00:00.000Z", endDate: "2026-02-01T00:00:00.000Z" },
      { id: 3, name: "Sprint 3", state: "active", startDate: "2026-02-02T00:00:00.000Z", endDate: "2026-02-15T00:00:00.000Z" },
      { id: 4, name: "Sprint 4", state: "future" },
    ];
    jira.state.changedKeys = [];

    const runId = await startSync();
    const { counts } = await runCounts(runId);
    expect(counts).toMatchObject({ sprintsCreated: 1, sprintsStarted: 1, sprintsCompleted: 1, issuesCreated: 0, issuesUpdated: 0 });

    const sprints = await admin.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId));
    const byName = (name: string) => sprints.find((s) => s.name === name);
    expect(byName("Sprint 2")?.state).toBe("closed");
    expect(byName("Sprint 3")?.state).toBe("active");
    expect(byName("Sprint 3")?.startAt?.toISOString()).toBe("2026-02-02T00:00:00.000Z");
    expect(byName("Sprint 4")?.state).toBe("future");

    const snaps = await admin.select().from(schema.sprintSnapshot);
    const kinds = snaps.filter((s) => s.sprintId === byName("Sprint 2")?.id).map((s) => s.kind);
    expect(kinds).toContain("complete");
    const startSnap = snaps.find((s) => s.sprintId === byName("Sprint 3")?.id && s.kind === "start");
    expect(startSnap?.takenAt?.toISOString()).toBe("2026-02-02T00:00:00.000Z");
  });

  it("an imported issue JIRA no longer lists is reported: a 404 as deleted, a different key as moved. Nothing is deleted", async () => {
    await fullImport();
    jira.state.changedKeys = [];
    jira.removeFromList("JSYNC-4"); // deleted: GET answers 404
    jira.moveOut("JSYNC-2", "OTHER-7"); // moved: GET answers with the new key

    const runId = await startSync();
    const { run } = await runCounts(runId);
    expect(run.notes).toMatchObject({ deletedInJira: ["JSYNC-4"], movedInJira: [{ key: "JSYNC-2", newKey: "OTHER-7" }] });
    expect(await issueByKey("JSYNC-4")).not.toBeNull();
    expect(await issueByKey("JSYNC-2")).not.toBeNull();
  });

  it("a field a user edited in Kompast since the last sync is reported as a conflict when JIRA changed the issue; JIRA's value wins for the field JIRA changed", async () => {
    await fullImport();
    const one = await issueByKey("JSYNC-1");
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, one!.id, { title: "Edited in Kompast", actorId: userId }));

    jira.edit("JSYNC-1", (i) => {
      i.fields.summary = "Changed in JIRA";
      i.fields.updated = nowSync();
      i.changelog.histories.push({ id: "h-c", created: nowSync(), author: importer, items: [item("summary", "Child story", "Changed in JIRA")] });
    });
    jira.state.changedKeys = ["JSYNC-1"];

    const runId = await startSync();
    const { run } = await runCounts(runId);
    expect(run.notes).toMatchObject({ conflicts: [{ issueKey: "JSYNC-1", fields: ["title"] }] });
    expect((await issueByKey("JSYNC-1"))?.title).toBe("Changed in JIRA");
  });

  it("a custom field JIRA changed since the last sync takes JIRA's value in its property; the issue's other custom values are kept", async () => {
    jira.state.fields = [{ id: "customfield_10050", name: "Topic", custom: true, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" } }];
    jira.edit("JSYNC-1", (i) => {
      i.fields.customfield_10050 = "alpha";
    });
    await fullImport();

    const [topic] = await admin.select().from(schema.issuePropertyDefinition).where(and(eq(schema.issuePropertyDefinition.projectId, projectId), eq(schema.issuePropertyDefinition.name, "Topic")));
    expect(topic).toBeDefined();
    const imported = await issueByKey("JSYNC-1");
    expect((imported?.customFields as Record<string, unknown>)[topic!.key]).toBe("alpha");

    jira.edit("JSYNC-1", (i) => {
      i.fields.customfield_10050 = "beta";
      i.fields.updated = nowSync();
      i.changelog.histories.push({
        id: "h-topic",
        created: nowSync(),
        author: importer,
        items: [{ field: "Topic", fieldId: "customfield_10050", fromString: "alpha", toString: "beta", from: null, to: null }],
      });
    });
    jira.state.changedKeys = ["JSYNC-1"];

    const runId = await startSync();
    const { counts } = await runCounts(runId);
    expect(counts).toMatchObject({ issuesUpdated: 1, issuesCreated: 0 });
    const after = await issueByKey("JSYNC-1");
    const custom = after?.customFields as Record<string, unknown>;
    expect(custom[topic!.key]).toBe("beta");
    expect(custom.jira).toEqual(expect.objectContaining({ originalKey: "JSYNC-1" }));
  });

  it("a due auto-sync is started as its creator in sync mode; one that isn't due, or has no token, is not", async () => {
    await fullImport();
    const past = new Date(Date.now() - 20 * 60_000);
    const recent = new Date(Date.now() - 2 * 60_000);
    await admin.update(schema.jiraMigration).set({ lastSyncedAt: past, autoSyncMinutes: 15 }).where(eq(schema.jiraMigration.id, migrationId));

    const due = await startDueJiraAutoSyncs(deps());
    expect(due.started).toEqual([migrationId]);
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.migrationId, migrationId)).orderBy(desc(schema.importRun.createdAt)).limit(1);
    expect(run).toMatchObject({ createdBy: userId, config: expect.objectContaining({ mode: "sync" }) });
    expect((await current()).state).toBe("running");

    // Back to synced: not due yet, so nothing starts.
    await admin.update(schema.jiraMigration).set({ state: "synced", lastSyncedAt: recent }).where(eq(schema.jiraMigration.id, migrationId));
    expect((await startDueJiraAutoSyncs(deps())).started).toEqual([]);

    // Due again, but no token: not started.
    await admin.update(schema.jiraMigration).set({ lastSyncedAt: past, apiTokenEncrypted: null }).where(eq(schema.jiraMigration.id, migrationId));
    expect((await startDueJiraAutoSyncs(deps())).started).toEqual([]);
    expect((await current()).state).toBe("synced");
  });
});

// ── fake JIRA ───────────────────────────────────────────────────────────────

/** The time of an edit made in JIRA now: after the full import, so the sync reads it as a change. */
function nowSync(): string {
  return new Date().toISOString();
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SPRINT_1 = { id: 1, name: "Sprint 1", state: "closed", startDate: "2024-01-01T00:00:00.000Z", endDate: "2024-01-14T00:00:00.000Z", completeDate: "2024-01-14T00:00:00.000Z" };
const SPRINT_2 = { id: 2, name: "Sprint 2", state: "active", startDate: "2024-01-15T00:00:00.000Z", endDate: "2024-01-28T00:00:00.000Z" };
const SPRINT_3 = { id: 3, name: "Sprint 3", state: "future" };

const importer = { accountId: "acc-importer", displayName: "Importer", emailAddress: "test-jira-sync-user@example.com", active: true, accountType: "atlassian" };

const adfText = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

function item(field: string, fromString: string | null, toString: string | null, from?: string | null, to?: string | null) {
  return { field, fromString, toString, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

interface FakeComment {
  id: string;
  author: unknown;
  body: unknown;
  created: string;
  updated?: string;
}

interface FakeWorklog {
  id: string;
  author: unknown;
  timeSpentSeconds: number;
  started: string;
}

interface FakeFields {
  summary: string;
  status: { name: string; statusCategory: { key: string; name: string } };
  comment?: { comments: FakeComment[]; total?: number };
  worklog?: { worklogs: FakeWorklog[]; total?: number };
  attachment?: unknown[];
  customfield_10020?: unknown;
  [key: string]: unknown;
}

interface FakeChangelogEntry {
  id: string;
  created: string;
  author: unknown;
  items: unknown[];
}

interface FakeIssue {
  id: string;
  key: string;
  fields: FakeFields;
  changelog: { histories: FakeChangelogEntry[]; total: number };
}

function newIssue(key: string, summary: string, created: string): FakeIssue {
  return {
    id: key,
    key,
    fields: {
      summary,
      issuetype: { name: "Task", subtask: false },
      status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
      assignee: null,
      reporter: importer,
      creator: importer,
      priority: { name: "Medium" },
      labels: [],
      description: null,
      created,
      updated: created,
      issuelinks: [],
      comment: { total: 0, comments: [] },
      worklog: { total: 0, worklogs: [] },
      attachment: [],
      customfield_10020: [SPRINT_2],
    },
    changelog: { histories: [], total: 0 },
  };
}

function fakeJira() {
  const state = {
    jqls: [] as string[],
    changedKeys: [] as string[],
    sprints: [SPRINT_1, SPRINT_2, SPRINT_3] as unknown[],
    statuses: [
      { name: "To Do", statusCategory: { key: "new" } },
      { name: "In Progress", statusCategory: { key: "indeterminate" } },
      { name: "Done", statusCategory: { key: "done" } },
    ],
    gone: new Set<string>(),
    moved: new Map<string, string>(),
    fields: [] as unknown[],
  };
  const issues: FakeIssue[] = [];
  const seed = (key: string, summary: string, status: string, category: string, sprint: unknown, created: string, extra: Partial<FakeIssue["fields"]> = {}) => {
    const issue = newIssue(key, summary, created);
    issue.fields.status = { name: status, statusCategory: { key: category, name: status } };
    issue.fields.customfield_10020 = [sprint];
    Object.assign(issue.fields, extra);
    issues.push(issue);
  };
  seed("JSYNC-1", "Child story", "In Progress", "indeterminate", SPRINT_2, "2024-01-05T00:00:00.000+0000", {
    comment: { total: 1, comments: [{ id: "c-1", author: importer, body: adfText("first"), created: "2024-01-05T00:00:00.000+0000", updated: "2024-01-05T00:00:00.000+0000" }] },
    worklog: { total: 1, worklogs: [{ id: "w-1", author: importer, timeSpentSeconds: 3600, started: "2024-01-06T00:00:00.000+0000" }] },
  } as Partial<FakeIssue["fields"]>);
  seed("JSYNC-2", "Parent epic", "Done", "done", SPRINT_1, "2024-01-03T00:00:00.000+0000");
  seed("JSYNC-3", "Blocker", "To Do", "new", SPRINT_2, "2024-01-04T00:00:00.000+0000");
  seed("JSYNC-4", "Gone soon", "Done", "done", SPRINT_1, "2024-01-02T00:00:00.000+0000");

  const issueJson = (i: FakeIssue) => ({
    id: i.id,
    key: i.key,
    fields: {
      ...i.fields,
      comment: { total: i.fields.comment?.comments.length ?? 0, comments: i.fields.comment?.comments ?? [] },
      worklog: { total: i.fields.worklog?.worklogs.length ?? 0, worklogs: i.fields.worklog?.worklogs ?? [] },
      watches: { watchCount: 0 },
    },
    changelog: { histories: i.changelog.histories, total: i.changelog.histories.length },
  });

  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/rest/api/3/myself") return json({ accountId: "acc-importer", displayName: "Importer", emailAddress: importer.emailAddress, timeZone: "Asia/Taipei" });
    if (path === "/rest/api/3/project/JSYNC") return json({ id: "20100", key: "JSYNC", name: "JIRA Sync" });
    if (path === "/rest/agile/1.0/board") return json({ values: [{ id: 7, name: "Sync board", type: "scrum" }], isLast: true });
    if (path === "/rest/agile/1.0/board/7/sprint") return json({ values: state.sprints.map((s) => ({ ...(s as object), originBoardId: 7 })), isLast: true });
    if (path === "/rest/api/3/project/JSYNC/statuses") return json([{ name: "Task", subtask: false, statuses: state.statuses }]);
    if (path === "/rest/api/3/priority") return json([{ name: "Medium" }]);
    if (path === "/rest/api/3/field") return json(state.fields);
    if (path === "/rest/api/3/search/jql") {
      const jql = url.searchParams.get("jql") ?? "";
      state.jqls.push(jql);
      const fields = url.searchParams.get("fields");
      const live = issues.filter((i) => !state.gone.has(i.key) && !state.moved.has(i.key));
      if (fields === "key") return json({ issues: live.map((i) => ({ id: i.id, key: i.key })), isLast: true });
      if (jql.includes("updated >=")) return json({ issues: live.filter((i) => state.changedKeys.includes(i.key)).map(issueJson), isLast: true });
      return json({ issues: live.map(issueJson), isLast: true });
    }
    const issueMatch = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (issueMatch) {
      const key = decodeURIComponent(issueMatch[1]!);
      if (state.gone.has(key)) return json({ errorMessages: ["Issue does not exist"] }, 404);
      if (state.moved.has(key)) return json({ id: "99", key: state.moved.get(key), fields: { project: { key: state.moved.get(key)!.split("-")[0] } } });
      return json({ id: key, key, fields: { project: { key: "JSYNC" } } });
    }
    return new Response(`no route for ${path}`, { status: 404 });
  });

  return {
    fetchMock,
    state,
    edit(key: string, change: (issue: FakeIssue) => void) {
      const issue = issues.find((i) => i.key === key);
      if (!issue) throw new Error(`no fake issue ${key}`);
      change(issue);
    },
    addIssue(issue: FakeIssue) {
      issues.push(issue);
    },
    removeFromList(key: string) {
      state.gone.add(key);
    },
    moveOut(key: string, newKey: string) {
      state.moved.set(key, newKey);
    },
  };
}
