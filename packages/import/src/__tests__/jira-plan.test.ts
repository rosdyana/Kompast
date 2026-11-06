import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, adminDb as admin } from "@kompast/db";
import { createImportRun, createProject, withAuthorizedTenant } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { loadJiraIssueBatch, prepareJiraImport, previewJiraMigrationPlan, type JiraImportInput, type JiraLoadContext } from "../jira/load";
import type { JiraIssue } from "../jira/types";
import type { JiraDiscovery } from "../jira/discover";
import type { JiraMigrationMapping } from "../jira/mapping";

/**
 * Column placement for created statuses (prepareJiraImport), and the
 * read-only preview, against real Postgres. Nothing here touches JIRA: the
 * discovery snapshot is a hand-built object.
 */
describe("JIRA plan: column placement and read-only preview (real Postgres)", () => {
  const orgId = "test-jira-plan-org";
  const userId = "test-jira-plan-user";
  const teamId = "test-jira-plan-team";
  const ctx = { userId, organizationId: orgId };

  let projectId: string;
  let boardId: string;

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Plan Test Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Planner", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Plan Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
    const project = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "jpln", name: "JIRA Plan", actorUserId: userId }));
    projectId = project.projectId;
    boardId = project.boardId;
  });

  afterAll(cleanup);

  const loadCtx = (): JiraLoadContext => ({
    organizationId: orgId,
    projectId,
    boardId,
    importRunId: "unused-no-sprints",
    actorUserId: userId,
    dryRun: false,
  });

  async function boardColumns() {
    const rows = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.boardId, boardId));
    return rows.sort((a, b) => a.order - b.order);
  }

  /** Row counts the wizard's read-only steps must never change. */
  async function countRows() {
    const statuses = await admin.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId));
    const types = await admin.select().from(schema.issueType).where(eq(schema.issueType.projectId, projectId));
    const sprints = await admin.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId));
    const columns = await boardColumns();
    return { statuses: statuses.length, types: types.length, sprints: sprints.length, columns: columns.length };
  }

  function mappingFor(statusNames: string[], placement: NonNullable<JiraMigrationMapping["statuses"][number]["column"]>): JiraMigrationMapping {
    return {
      statuses: statusNames.map((jiraName) => ({ jiraName, category: "todo", action: "create", column: placement })),
      types: [],
      people: [],
      priorities: [],
      attachmentMaxBytes: 10 * 1024 * 1024,
    };
  }

  it("statuses created after the same column land in the mapping's order, not reversed", async () => {
    const colTodo = (await boardColumns()).find((c) => c.name === "To Do")!;
    const names = ["Ready for QA", "Blocked", "Waiting on vendor"];
    const input: JiraImportInput = {
      statuses: names.map((name) => ({ name, categoryKey: "new" })),
      types: [],
      sprints: [],
      mapping: mappingFor(names, { mode: "new", afterColumnId: colTodo.id }),
    };

    const prepared = await withAuthorizedTenant(ctx, (tx) => prepareJiraImport(tx, loadCtx(), input));
    expect(prepared.counts.statusesCreated).toBe(3);

    const after = await boardColumns();
    expect(after.map((c) => c.name)).toEqual(["Backlog", "To Do", "Ready for QA", "Blocked", "Waiting on vendor", "In Progress", "In Review", "Done"]);
    expect(after.map((c) => c.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("a null afterColumnId puts the created statuses at the start, in order; a join adds to an existing column", async () => {
    const done = (await boardColumns()).find((c) => c.name === "Done")!;
    const input: JiraImportInput = {
      statuses: [
        { name: "Triage", categoryKey: "new" },
        { name: "Shipped", categoryKey: "done" },
      ],
      types: [],
      sprints: [],
      mapping: {
        statuses: [
          { jiraName: "Triage", category: "todo", action: "create", column: { mode: "new", afterColumnId: null } },
          { jiraName: "Shipped", category: "done", action: "create", column: { mode: "join", columnId: done.id } },
        ],
        types: [],
        people: [],
        priorities: [],
        attachmentMaxBytes: null,
      },
    };

    await withAuthorizedTenant(ctx, (tx) => prepareJiraImport(tx, loadCtx(), input));

    const after = await boardColumns();
    expect(after.map((c) => c.name)).toEqual(["Triage", "Backlog", "To Do", "In Progress", "In Review", "Done"]);
    const doneLinks = await admin.select().from(schema.boardColumnStatus).where(eq(schema.boardColumnStatus.boardColumnId, done.id));
    expect(doneLinks).toHaveLength(2);
  });

  it("the preview writes nothing, and reports the plan a run would apply", async () => {
    const before = await countRows();
    const colTodo = (await boardColumns()).find((c) => c.name === "To Do")!;

    const discovery = {
      issueCount: 4,
      minKeyNumber: 1,
      maxKeyNumber: 9,
      statuses: [
        { name: "Ready for QA", categoryKey: "new" },
        { name: "To Do", categoryKey: "new" },
        { name: "Shipped", categoryKey: "done" },
      ],
      issueTypes: [{ name: "Bug Report", subtask: false }, { name: "Improvement", subtask: false }],
      priorities: [{ name: "Highest" }, { name: "Trivial" }],
      sprints: [],
      attachmentSizes: [1024, 20 * 1024 * 1024, 5 * 1024 * 1024],
    } as unknown as JiraDiscovery;

    const [todoStatus] = await admin.select().from(schema.workflowStatus).where(and(eq(schema.workflowStatus.projectId, projectId), eq(schema.workflowStatus.name, "To Do")));
    const mapping: JiraMigrationMapping = {
      statuses: [
        { jiraName: "Ready for QA", category: "todo", action: "create", column: { mode: "new", afterColumnId: colTodo.id } },
        { jiraName: "To Do", category: "todo", action: "map", kompastStatusId: todoStatus!.id },
        { jiraName: "Shipped", category: "done", action: "create", column: { mode: "new", afterColumnId: null } },
      ],
      types: [{ jiraName: "Bug Report", action: "create" }, { jiraName: "Improvement", action: "create" }],
      people: [
        { accountId: "a-1", displayName: "Known", action: "map", kompastUserId: userId, confidence: "email" },
        { accountId: "a-2", displayName: "Gone", action: "former", confidence: "none" },
      ],
      priorities: [{ jiraName: "Trivial", kompastKey: "high" }],
      attachmentMaxBytes: 10 * 1024 * 1024,
    };

    const preview = await withAuthorizedTenant(ctx, (tx) => previewJiraMigrationPlan(tx, { organizationId: orgId, projectId, boardId }, discovery, mapping));

    expect(await countRows()).toEqual(before);

    expect(preview).toMatchObject({ issueCount: 4, minKeyNumber: 1, maxKeyNumber: 9 });
    expect(preview.statusesToCreate.map((s) => s.name)).toEqual(["Ready for QA", "Shipped"]);
    expect(preview.statusesToCreate[0]!.column).toEqual({ mode: "new", afterColumnId: colTodo.id });
    expect(preview.typesToCreate.map((t) => t.name)).toEqual(["Bug Report", "Improvement"]);
    // "Trivial" takes the mapping's choice; "Highest" has no entry, so it takes the suggestion.
    expect(preview.priorities).toEqual([
      { jiraName: "Highest", kompastKey: "critical", kompastName: "Critical" },
      { jiraName: "Trivial", kompastKey: "high", kompastName: "High" },
    ]);
    expect(preview.people).toEqual({ mapped: 1, former: 1 });
    // 10 MiB limit: the 20 MiB file stays in JIRA, the other two are copied.
    expect(preview.attachments).toEqual({
      total: 3,
      totalBytes: 1024 + 20 * 1024 * 1024 + 5 * 1024 * 1024,
      migrated: 2,
      migratedBytes: 1024 + 5 * 1024 * 1024,
      placeholders: 1,
      placeholderBytes: 20 * 1024 * 1024,
    });
    // Plain JSON, so it can go straight to the browser.
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
  });

  it("the loader writes each issue's priority from the mapping, then the suggestion, never a key the project lacks", async () => {
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }),
    );
    const input: JiraImportInput = {
      statuses: [{ name: "To Do", categoryKey: "new" }],
      types: [{ name: "Task" }],
      sprints: [],
      mapping: { statuses: [], types: [], people: [], priorities: [{ jiraName: "Highest", kompastKey: "high" }], attachmentMaxBytes: null },
    };
    const issue = (key: string, priority: string | null): JiraIssue => ({
      id: key,
      key,
      fields: {
        summary: key,
        issuetype: { name: "Task", subtask: false },
        status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
        assignee: null,
        reporter: null,
        priority: priority === null ? null : { name: priority },
        labels: [],
        description: null,
        created: "2024-01-01T00:00:00.000+0000",
      },
    });
    const issues = [issue("JPLN-1", "Highest"), issue("JPLN-2", "Lowest"), issue("JPLN-3", null), issue("JPLN-4", "Blocker")];
    const loadWith = { ...loadCtx(), importRunId };

    const prepared = await withAuthorizedTenant(ctx, (tx) => prepareJiraImport(tx, loadWith, input));
    await withAuthorizedTenant(ctx, (tx) => loadJiraIssueBatch(tx, issues, loadWith, prepared));

    const rows = await admin.select({ title: schema.issue.title, priority: schema.issue.priority }).from(schema.issue).where(eq(schema.issue.projectId, projectId));
    expect(Object.fromEntries(rows.map((r) => [r.title, r.priority]))).toEqual({
      "JPLN-1": "high",
      "JPLN-2": "very_low",
      "JPLN-3": "medium",
      "JPLN-4": "critical",
    });
  });

  it("the preview's 'no limit' setting copies every attachment", async () => {
    const discovery = { issueCount: 0, minKeyNumber: null, maxKeyNumber: null, statuses: [], issueTypes: [], priorities: [], sprints: [], attachmentSizes: [1, 2 ** 40] } as unknown as JiraDiscovery;
    const preview = await withAuthorizedTenant(ctx, (tx) =>
      previewJiraMigrationPlan(tx, { organizationId: orgId, projectId, boardId }, discovery, {
        statuses: [],
        types: [],
        people: [],
        priorities: [],
        attachmentMaxBytes: null,
      }),
    );
    expect(preview.attachments).toMatchObject({ migrated: 2, placeholders: 0 });
    expect(await admin.select().from(schema.workflowStatus).where(and(eq(schema.workflowStatus.projectId, projectId)))).toHaveLength(5);
  });
});
