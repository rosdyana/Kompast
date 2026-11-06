import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, eq, and, adminDb as admin } from "@kompast/db";
import {
  claimJiraMigrations,
  createJiraMigration,
  createProject,
  finishJiraMigration,
  getJiraMigration,
  requestJiraDiscovery,
  startJiraMigrationRun,
  withAuthorizedTenant,
  type JiraMigrationPublic,
} from "@kompast/core";
import { id } from "@kompast/core/ids";
import { createJiraClient } from "../jira/client";
import { runJiraMigrationTick } from "../jira/migration-runner";
import { RECONCILE_DIFFERENCE_CAP, ReconcileLog, emptyReconcileCounts, reconcileIsClean, type ReconcileDifference } from "../jira/reconcile";

/**
 * The reconciliation report against real Postgres, with JIRA mocked behind the real client. One file, run in order:
 * each test loads its own migration, then reconciles it. Claims are pushed to the front of the claim order, as in
 * jira-migration-runner.test.ts, because claimJiraMigrations is a system-wide scan.
 */
describe("JIRA reconciliation (real Postgres, mocked JIRA)", () => {
  const orgId = "test-jira-reconcile-org";
  const userId = "test-jira-reconcile-user";
  const teamId = "test-jira-reconcile-team";
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
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Reconcile Test Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Importer", email: creatorEmail });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Reconcile Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });

    const project = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "jrec", name: "JIRA Reconcile", actorUserId: userId }));
    projectId = project.projectId;
    boardId = project.boardId;

    const created = await withAuthorizedTenant(ctx, (tx) =>
      createJiraMigration(tx, ctx, {
        projectId,
        boardId,
        siteUrl: "https://jira.example.net/",
        email: creatorEmail,
        apiToken: "jira-token-xyz",
        jiraProjectKey: "JRUN",
        jiraBoardId: 7,
      }),
    );
    migrationId = created.migrationId;
    jira = fakeJira(INITIAL_ISSUES());
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

  /** The worker's path: lease our row, then tick it. */
  async function claimOurs(): Promise<JiraMigrationPublic> {
    await admin.update(schema.jiraMigration).set({ updatedAt: new Date("1999-01-01T00:00:00Z") }).where(eq(schema.jiraMigration.id, migrationId));
    const claimed = await claimJiraMigrations(admin, 60_000);
    const row = claimed.find((m) => m.id === migrationId);
    if (!row) throw new Error("the migration was not claimed");
    return row;
  }

  async function current(): Promise<JiraMigrationPublic> {
    const row = await withAuthorizedTenant(ctx, (tx) => getJiraMigration(tx, migrationId));
    if (!row) throw new Error("migration not visible");
    return row;
  }

  /** Discovery, mapping suggestion, and one full load: the migration ends synced. */
  async function loadAll() {
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));
    await runJiraMigrationTick(deps(), await claimOurs());
    await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));
    await runJiraMigrationTick(deps(), await claimOurs());
    expect(await current()).toMatchObject({ state: "synced" });
  }

  /** Starts a reconcile and ticks it to its end. Returns the reconcile import run as stored. */
  async function reconcileAll() {
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId, { mode: "reconcile" }));
    await runJiraMigrationTick(deps(), await claimOurs());
    expect(await current()).toMatchObject({ state: "synced" });
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    if (!run) throw new Error("the reconcile run is missing");
    return run;
  }

  async function keyToIssueId(key: string): Promise<string> {
    const [ref] = await admin
      .select()
      .from(schema.externalRef)
      .where(and(eq(schema.externalRef.organizationId, orgId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.sourceId, key)));
    if (!ref) throw new Error(`no external ref for ${key}`);
    return ref.entityId;
  }

  async function statusIdNamed(name: string): Promise<string> {
    const [row] = await admin.select().from(schema.workflowStatus).where(and(eq(schema.workflowStatus.projectId, projectId), eq(schema.workflowStatus.name, name)));
    if (!row) throw new Error(`no status ${name}`);
    return row.id;
  }

  it("a clean import reconciles with nothing unexplained: the only difference is the explained not-migrated attachment, and the migration stays synced", async () => {
    await loadAll();
    const before = await current();

    const run = await reconcileAll();

    expect(run).toMatchObject({ status: "completed", migrationId });
    expect(run.config).toMatchObject({ mode: "reconcile", jiraProjectKey: "JRUN" });
    const counts = run.counts as unknown as Record<string, { jira: number; kompast: number; matched: number; explained: number; unexplained: number }>;
    for (const [category, tally] of Object.entries(counts)) expect({ category, unexplained: tally.unexplained }).toEqual({ category, unexplained: 0 });
    expect(counts.issues).toEqual({ jira: 4, kompast: 4, matched: 4, explained: 0, unexplained: 0 });
    expect(counts.attachments).toEqual({ jira: 1, kompast: 1, matched: 0, explained: 1, unexplained: 0 });
    // The mapped "Team" field is written to a property, and the reconcile reads it back as the same value.
    expect(counts.fields).toEqual({ jira: 1, kompast: 1, matched: 1, explained: 0, unexplained: 0 });
    // Every board sprint is imported with its state and name.
    expect(counts.sprints).toEqual({ jira: 3, kompast: 3, matched: 3, explained: 0, unexplained: 0 });
    const [teamValue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, await keyToIssueId("JRUN-1")));
    expect(Object.values(teamValue!.customFields as Record<string, unknown>)).toContain("Platform");

    const notes = run.notes as unknown as { differences: ReconcileDifference[]; truncated: number; clean: boolean };
    expect(notes.clean).toBe(true);
    expect(notes.truncated).toBe(0);
    expect(notes.differences).toEqual([
      expect.objectContaining({ category: "attachments", issueKey: "JRUN-1", jira: "big.zip", kompast: "not_migrated", reason: "explained:not-migrated" }),
    ]);

    // A reconcile changes no data: lastSyncedAt is the same, and the migration is back to synced without a cursor.
    const after = await current();
    expect(after.lastSyncedAt?.getTime()).toBe(before.lastSyncedAt?.getTime());
    expect(after.cursor).toBeNull();
    expect(after.hasToken).toBe(true);
  });

  it("reports exactly the differences a deleted comment, an edit in Kompast, an unsynced JIRA change, a new JIRA issue, a deleted JIRA issue and a not-migrated file make", async () => {
    await loadAll();

    // Kompast: a comment deleted, and JRUN-2's status changed by a user after the sync (non-import history).
    const [c2] = await admin
      .select()
      .from(schema.externalRef)
      .where(and(eq(schema.externalRef.organizationId, orgId), eq(schema.externalRef.sourceId, "JRUN-1/c2")));
    await admin.delete(schema.issueComment).where(eq(schema.issueComment.id, c2!.entityId));
    const jrun2 = await keyToIssueId("JRUN-2");
    await admin.insert(schema.issueHistory).values({
      id: id("hist"),
      issueId: jrun2,
      actorId: userId,
      origin: "user",
      field: "status",
      fromValue: null,
      toValue: null,
      createdAt: new Date(Date.now() + 60_000),
    });
    await admin.update(schema.issue).set({ statusId: await statusIdNamed("In Progress") }).where(eq(schema.issue.id, jrun2));

    // JIRA: JRUN-3 moved to Done (not synced), JRUN-5 deleted, JRUN-4 created.
    jira.state.issues = jira.state.issues.filter((i) => i.key !== "JRUN-5");
    jira.state.issues = jira.state.issues.map((i) => (i.key === "JRUN-3" ? issue("JRUN-3", { ...SPEC.JRUN3, status: "Done", category: "done" }) : i));
    jira.state.issues.push(issue("JRUN-4", { summary: "Brand new", status: "To Do", category: "new", created: "2024-02-01T00:00:00.000+0000", sprint: SPRINT_3 }));

    const run = await reconcileAll();

    const counts = run.counts as unknown as Record<string, { explained: number; unexplained: number }>;
    expect(counts.comments).toMatchObject({ unexplained: 1 });
    expect(counts.status).toMatchObject({ explained: 1, unexplained: 1 });
    expect(counts.issues).toMatchObject({ unexplained: 1 });
    expect(counts.missingInJira).toMatchObject({ explained: 1, unexplained: 0 });
    expect(counts.attachments).toMatchObject({ explained: 1, unexplained: 0 });

    const notes = run.notes as unknown as { differences: ReconcileDifference[]; truncated: number; clean: boolean };
    expect(notes.clean).toBe(false);
    expect(notes.differences).toEqual([
      { category: "comments", issueKey: "JRUN-1", jira: 2, kompast: 1, reason: "unexplained" },
      expect.objectContaining({ category: "attachments", issueKey: "JRUN-1", reason: "explained:not-migrated" }),
      { category: "status", issueKey: "JRUN-2", jira: "Done", kompast: "In Progress", reason: "explained:edited-in-kompast" },
      { category: "status", issueKey: "JRUN-3", jira: "Done", kompast: "To Do", reason: "unexplained" },
      expect.objectContaining({ category: "issues", issueKey: "JRUN-4", jira: "JRUN-4", kompast: null, reason: "unexplained" }),
      expect.objectContaining({ category: "missingInJira", issueKey: "JRUN-5", jira: null, kompast: "JRUN-5", reason: "explained:deleted" }),
    ]);
  });

  it("finish refuses without a reconcile after the last sync, and refuses unexplained differences unless they are acknowledged; then it clears the token and turns auto-sync off", async () => {
    // A reconcile can't start before a sync has finished: the migration is only ready here.
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));
    await runJiraMigrationTick(deps(), await claimOurs());
    await withAuthorizedTenant(ctx, (tx) => expect(startJiraMigrationRun(tx, ctx, migrationId, { mode: "reconcile" })).rejects.toThrow(/Check completeness after a finished sync/));

    await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));
    await runJiraMigrationTick(deps(), await claimOurs());
    expect(await current()).toMatchObject({ state: "synced" });
    await expect(withAuthorizedTenant(ctx, (tx) => finishJiraMigration(tx, ctx, migrationId))).rejects.toThrow(/Check completeness/);

    // An unexplained difference: a title edited in Kompast without history, and a JIRA status change not synced.
    await admin.update(schema.issue).set({ title: "edited in Kompast" }).where(eq(schema.issue.id, await keyToIssueId("JRUN-1")));
    jira.state.issues = jira.state.issues.map((i) => (i.key === "JRUN-3" ? issue("JRUN-3", { ...SPEC.JRUN3, status: "Done", category: "done" }) : i));

    await reconcileAll();
    await admin.update(schema.jiraMigration).set({ autoSyncMinutes: 60 }).where(eq(schema.jiraMigration.id, migrationId));

    await expect(withAuthorizedTenant(ctx, (tx) => finishJiraMigration(tx, ctx, migrationId))).rejects.toThrow(/need a look/);
    expect(await current()).toMatchObject({ state: "synced", hasToken: true });

    await withAuthorizedTenant(ctx, (tx) => finishJiraMigration(tx, ctx, migrationId, { acknowledgedDifferences: true }));
    expect(await current()).toMatchObject({ state: "completed", hasToken: false, autoSyncMinutes: null });
  });

  it("a sync chained into a reconcile applies the JIRA change, then runs the reconcile and returns the migration to synced", async () => {
    await loadAll();
    const syncedBefore = (await current()).lastSyncedAt!.getTime();
    // A sync reads changes from the changelog (not from `updated`), so the rename comes with a summary history entry.
    const renamedIssue: FakeIssue = {
      ...issue("JRUN-1", { ...SPEC.JRUN1, summary: "Child story, renamed" }),
      changelog: { histories: [{ created: new Date(Date.now() + 1000).toISOString(), author: importer, items: [{ field: "summary", fieldId: "summary", fromString: "Child story", toString: "Child story, renamed" }] }] },
    };
    jira.state.issues = jira.state.issues.map((i) => (i.key === "JRUN-1" ? renamedIssue : i));

    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId, { mode: "sync", then: "reconcile" }));
    await runJiraMigrationTick(deps(), await claimOurs());
    // The sync's data is in: the migration is still running, now on the reconcile.
    expect(await current()).toMatchObject({ state: "running" });
    await runJiraMigrationTick(deps(), await claimOurs());

    const after = await current();
    expect(after.state).toBe("synced");
    expect(after.lastSyncedAt!.getTime()).toBeGreaterThan(syncedBefore);
    const [renamed] = await admin.select().from(schema.issue).where(eq(schema.issue.id, await keyToIssueId("JRUN-1")));
    expect(renamed).toMatchObject({ title: "Child story, renamed" });

    const [syncRun] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(syncRun).toMatchObject({ status: "completed", config: expect.objectContaining({ mode: "sync", then: "reconcile" }) });

    const reconciles = await admin.select().from(schema.importRun).where(and(eq(schema.importRun.migrationId, migrationId), eq(schema.importRun.status, "completed")));
    const reconcile = reconciles.find((r) => (r.config as { mode?: string }).mode === "reconcile");
    expect(reconcile).toBeDefined();
    expect((reconcile!.notes as unknown as { clean: boolean }).clean).toBe(true);
  });

  it("a Done issue on two closed sprints whose start date was edited after completion (ZTRD-2895) reconciles clean on the sprint the loader picked", async () => {
    // Sprint 97's start date was set after it closed, so by start date 98 comes first. The loader orders by sprint number
    // and puts the issue (done, no open sprint) on its last sprint, 98. The reconcile must derive the same sprint.
    const sprint97: SprintFixture = { id: 97, name: "Sprint 97", state: "closed", startDate: "2026-06-03T08:29:00.000Z", endDate: "2026-06-03T02:38:00.000Z", completeDate: "2026-06-03T02:38:00.000Z" };
    const sprint98: SprintFixture = { id: 98, name: "Sprint 98", state: "closed", startDate: "2026-06-03T02:40:00.000Z", endDate: "2026-06-17T07:57:00.000Z", completeDate: "2026-06-17T07:57:00.000Z" };
    jira = fakeJira(
      [issue("JRUN-7", { summary: "Edited start date", status: "Done", category: "done", created: "2026-05-20T00:00:00.000+0000", sprint: [sprint97, sprint98] })],
      [sprint97, sprint98],
    );

    await loadAll();
    const run = await reconcileAll();

    const counts = run.counts as unknown as Record<string, { jira: number; kompast: number; matched: number; explained: number; unexplained: number }>;
    expect(counts.sprint).toEqual({ jira: 1, kompast: 1, matched: 1, explained: 0, unexplained: 0 });
    expect(counts.sprints).toEqual({ jira: 2, kompast: 2, matched: 2, explained: 0, unexplained: 0 });
    const notes = run.notes as unknown as { differences: ReconcileDifference[]; clean: boolean };
    expect(notes.differences.filter((d) => d.category === "sprint")).toEqual([]);
    expect(notes.clean).toBe(true);

    const [ref98] = await admin
      .select()
      .from(schema.externalRef)
      .where(and(eq(schema.externalRef.organizationId, orgId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.sourceId, "sprint:98")));
    const [loaded] = await admin.select().from(schema.issue).where(eq(schema.issue.id, await keyToIssueId("JRUN-7")));
    expect(loaded!.sprintId).toBe(ref98!.entityId);
  });
});

describe("reconciliation log", () => {
  it("keeps at most the cap of differences, counts every one past it, and still reports the category as unexplained", () => {
    const log = new ReconcileLog(emptyReconcileCounts(), [], 0);
    for (let i = 0; i < RECONCILE_DIFFERENCE_CAP + 5; i++) {
      log.difference({ category: "title", issueKey: `JRUN-${i}`, jira: "a", kompast: "b", reason: "unexplained" });
    }
    expect(log.differences).toHaveLength(RECONCILE_DIFFERENCE_CAP);
    expect(log.truncated).toBe(5);
    expect(log.counts.title.unexplained).toBe(RECONCILE_DIFFERENCE_CAP + 5);
    expect(reconcileIsClean(log.counts)).toBe(false);
  });

  it("is clean when every difference is explained", () => {
    const log = new ReconcileLog(emptyReconcileCounts(), [], 0);
    log.difference({ category: "status", issueKey: "JRUN-1", jira: "Done", kompast: "To Do", reason: "explained:edited-in-kompast" });
    expect(reconcileIsClean(log.counts)).toBe(true);
  });
});

// ── JIRA fixtures ───────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SPRINT_1 = { id: 1, name: "Sprint 1", state: "closed", startDate: "2024-01-01T00:00:00.000Z", endDate: "2024-01-14T00:00:00.000Z", completeDate: "2024-01-14T00:00:00.000Z" };
const SPRINT_2 = { id: 2, name: "Sprint 2", state: "active", startDate: "2024-01-15T00:00:00.000Z", endDate: "2024-01-28T00:00:00.000Z" };
const SPRINT_3 = { id: 3, name: "Sprint 3", state: "future" };

const importer = { accountId: "acc-importer", displayName: "Importer", emailAddress: "test-jira-reconcile-user@example.com", active: true, accountType: "atlassian" };

const comment = (cid: string, text: string) => ({
  id: cid,
  author: importer,
  body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  created: "2024-01-06T00:00:00.000+0000",
  updated: "2024-01-06T00:00:00.000+0000",
});

interface SprintFixture {
  id: number;
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
  completeDate?: string;
}

interface IssueOpts {
  summary: string;
  status: string;
  category: "new" | "indeterminate" | "done";
  created: string;
  sprint: SprintFixture | SprintFixture[];
  parentKey?: string;
  blocks?: string;
  comments?: ReturnType<typeof comment>[];
  attachments?: { id: string; filename: string; size: number; content: string }[];
  watchCount?: number;
  /** A text custom field (customfield_10050, "Team"): the mapping suggests it as a property. */
  team?: string;
}

function issue(key: string, o: IssueOpts) {
  const comments = o.comments ?? [];
  return {
    id: key,
    key,
    fields: {
      summary: o.summary,
      issuetype: { name: "Task", subtask: false },
      status: { name: o.status, statusCategory: { key: o.category, name: o.status } },
      assignee: importer,
      reporter: importer,
      creator: importer,
      priority: { name: "Medium" },
      labels: [],
      description: null,
      created: o.created,
      updated: "2024-01-10T00:00:00.000+0000",
      ...(o.parentKey ? { parent: { key: o.parentKey } } : {}),
      issuelinks: o.blocks ? [{ type: { name: "Blocks" }, outwardIssue: { key: o.blocks } }] : [],
      comment: { total: comments.length, comments },
      worklog: { total: 0, worklogs: [] },
      attachment: (o.attachments ?? []).map((a) => ({ ...a, mimeType: "application/zip", created: "2024-01-06T00:00:00.000+0000", author: importer })),
      watches: { watchCount: o.watchCount ?? 0 },
      customfield_10020: Array.isArray(o.sprint) ? o.sprint : [o.sprint],
      ...(o.team ? { customfield_10050: o.team } : {}),
    },
  };
}

/** The fixtures every test starts from. JRUN-5 is in JIRA at the load and is deleted before a reconcile in one test. */
const SPEC = {
  JRUN1: {
    summary: "Child story",
    status: "In Progress",
    category: "indeterminate" as const,
    created: "2024-01-05T00:00:00.000+0000",
    sprint: SPRINT_2,
    parentKey: "JRUN-2",
    comments: [comment("c1", "first"), comment("c2", "second")],
    attachments: [{ id: "att-1", filename: "big.zip", size: 20 * 1024 * 1024, content: "https://jira.example.net/rest/api/3/attachment/content/att-1" }],
    watchCount: 1,
    team: "Platform",
  },
  JRUN2: { summary: "Parent epic", status: "Done", category: "done" as const, created: "2024-01-03T00:00:00.000+0000", sprint: SPRINT_1 },
  JRUN3: { summary: "Blocker", status: "To Do", category: "new" as const, created: "2024-01-04T00:00:00.000+0000", sprint: SPRINT_3, blocks: "JRUN-2" },
  JRUN5: { summary: "Soon to be deleted", status: "To Do", category: "new" as const, created: "2024-01-02T00:00:00.000+0000", sprint: SPRINT_3 },
};

function INITIAL_ISSUES() {
  return [issue("JRUN-1", SPEC.JRUN1), issue("JRUN-2", SPEC.JRUN2), issue("JRUN-3", SPEC.JRUN3), issue("JRUN-5", SPEC.JRUN5)];
}

type FakeIssue = ReturnType<typeof issue> & { changelog?: unknown };

function fakeJira(initial: FakeIssue[], boardSprints: SprintFixture[] = [SPRINT_1, SPRINT_2, SPRINT_3]) {
  const state = { issues: initial };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;

    if (path === "/rest/api/3/myself") return json({ accountId: "acc-importer", displayName: "Importer", emailAddress: importer.emailAddress });
    if (path === "/rest/api/3/project/JRUN") return json({ id: "20000", key: "JRUN", name: "JIRA Reconcile" });
    if (path === "/rest/agile/1.0/board") return json({ values: [{ id: 7, name: "Reconcile board", type: "scrum" }], isLast: true });
    if (path === "/rest/agile/1.0/board/7/sprint") return json({ values: boardSprints.map((s) => ({ ...s, originBoardId: 7 })), isLast: true });
    if (path === "/rest/api/3/project/JRUN/statuses") {
      return json([
        {
          name: "Task",
          subtask: false,
          statuses: [
            { name: "To Do", statusCategory: { key: "new" } },
            { name: "In Progress", statusCategory: { key: "indeterminate" } },
            { name: "Done", statusCategory: { key: "done" } },
          ],
        },
      ]);
    }
    if (path === "/rest/api/3/priority") return json([{ name: "Medium" }]);
    if (path === "/rest/api/3/field") {
      return json([
        { id: "customfield_10020", name: "Sprint", custom: true, schema: { type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
        { id: "customfield_10050", name: "Team", custom: true, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" } },
      ]);
    }
    if (path === "/rest/api/3/search/jql") return json({ issues: state.issues, isLast: true });

    const watchers = /^\/rest\/api\/3\/issue\/([^/]+)\/watchers$/.exec(path);
    if (watchers) {
      const key = decodeURIComponent(watchers[1]!);
      return json({ watchers: key === "JRUN-1" ? [importer] : [] });
    }
    const single = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (single) {
      const key = decodeURIComponent(single[1]!);
      const found = state.issues.find((i) => i.key === key);
      if (!found) return json({ errorMessages: ["Issue does not exist or you do not have permission to see it."] }, 404);
      return json({ key, fields: { project: { key: "JRUN" } } });
    }
    return new Response(`no route for ${path}`, { status: 404 });
  });
  return { fetchMock, state };
}
