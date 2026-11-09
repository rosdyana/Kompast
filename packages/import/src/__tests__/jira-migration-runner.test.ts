import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, eq, and, inArray, adminDb as admin } from "@kompast/db";
import {
  claimJiraMigrations,
  createJiraMigration,
  createProject,
  getJiraMigration,
  requestJiraDiscovery,
  startJiraMigrationRun,
  withAuthorizedTenant,
  type JiraMigrationPublic,
} from "@kompast/core";
import { id } from "@kompast/core/ids";
import { createJiraClient } from "../jira/client";
import type { JiraDiscovery } from "../jira/discover";
import { runJiraMigrationTick, type JiraMigrationCursor } from "../jira/migration-runner";
import type { JiraMigrationMapping } from "../jira/mapping";

/**
 * The batched migration end to end, against real Postgres with JIRA mocked
 * behind the real client. One file, run serially (vitest's in-file order),
 * because claimJiraMigrations is a system-wide scan: each test claims only its
 * own row (see claimOurs).
 */
describe("JIRA migration runner (real Postgres, mocked JIRA)", () => {
  const orgId = "test-jira-runner-org";
  const userId = "test-jira-runner-user";
  const teamId = "test-jira-runner-team";
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
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Runner Test Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Importer", email: creatorEmail });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Runner Team" });
    // The creator must be on the project's team, or team-scoped RLS hides the project from them.
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });

    const project = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "jrun", name: "JIRA Runner", actorUserId: userId }),
    );
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

  /** The worker's path: lease our row (the claim is scoped to it), then tick it. */
  async function claimOurs(): Promise<JiraMigrationPublic> {
    const claimed = await claimJiraMigrations(admin, 60_000, [migrationId]);
    const row = claimed.find((m) => m.id === migrationId);
    if (!row) throw new Error("the migration was not claimed");
    return row;
  }

  async function current(): Promise<JiraMigrationPublic> {
    const row = await withAuthorizedTenant(ctx, (tx) => getJiraMigration(tx, migrationId));
    if (!row) throw new Error("migration not visible");
    return row;
  }

  /** JIRA issue key -> Kompast issue id, from external_ref. */
  async function issueIdsByKey(): Promise<Map<string, string>> {
    const refs = await admin
      .select()
      .from(schema.externalRef)
      .where(and(eq(schema.externalRef.organizationId, orgId), eq(schema.externalRef.source, "jira"), eq(schema.externalRef.entityType, "issue")));
    return new Map(refs.map((r) => [r.sourceId, r.entityId]));
  }

  it("discovery surveys the project and saves a suggested mapping, leaving the migration ready with its lease released", async () => {
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));

    // A pinned clock: both scanned pages fall inside one 2-second window, so only the first running count is written.
    await runJiraMigrationTick({ ...deps(), now: () => new Date("2030-01-01T00:00:00Z") }, await claimOurs());

    const m = await current();
    expect(m.state).toBe("ready");
    expect(m.error).toBeNull();
    expect(m.leaseExpiresAt).toBeNull();
    expect(m.hasToken).toBe(true);
    expect(m.progress).toEqual({ phase: "discovery", done: 2, total: null });

    const discovery = m.discovery as unknown as JiraDiscovery;
    expect(discovery.issueCount).toBe(4);
    expect(discovery.board?.id).toBe(7);

    const mapping = m.mapping as unknown as JiraMigrationMapping;
    expect(mapping.people).toEqual([expect.objectContaining({ accountId: "acc-importer", action: "map", confidence: "email", kompastUserId: userId })]);
    expect(mapping.statuses.find((s) => s.jiraName === "Done")).toMatchObject({ action: "map" });
  });

  it("loads a two-page project over several ticks: a deferred parent and link resolve at finalize, a failed page retries, and the run ends synced", async () => {
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));
    await runJiraMigrationTick(deps(), await claimOurs());
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));

    // Page 2 is rejected by JIRA once.
    jira.state.failPage2Once = true;
    await runJiraMigrationTick(deps(), await claimOurs());

    // Tick 1: page 1 loaded. Its child's parent and its link target are on page 2, so both are deferred. Page 2 failed once.
    let m = await current();
    expect(m.state).toBe("running");
    const afterFailure = m.cursor as unknown as JiraMigrationCursor;
    expect(afterFailure).toMatchObject({ importRunId, nextPageToken: "page-2", pagesDone: 1, attemptsOnPage: 1 });
    expect(afterFailure.deferredParents).toEqual([
      { childKey: "JRUN-1", parentKey: "JRUN-2", createdAt: "2024-01-05T00:00:00.000+0000", historyActorId: userId },
    ]);
    expect(afterFailure.deferredLinks).toEqual([{ fromKey: "JRUN-3", toKey: "JRUN-4", type: "blocks" }]);
    expect([...(await issueIdsByKey()).keys()].sort()).toEqual(["JRUN-1", "JRUN-3"]);

    // Tick 2: page 2 loads, then finalize resolves the deferred parent and link and the run closes.
    await runJiraMigrationTick(deps(), await claimOurs());

    m = await current();
    expect(m.state).toBe("synced");
    expect(m.lastSyncedAt).not.toBeNull();
    expect(m.leaseExpiresAt).toBeNull();
    expect(m.hasToken).toBe(true);
    expect(m.cursor).toMatchObject({ pagesDone: 2, attemptsOnPage: 0 });

    const ids = await issueIdsByKey();
    expect([...ids.keys()].sort()).toEqual(["JRUN-1", "JRUN-2", "JRUN-3", "JRUN-4"]);
    const issueRows = await admin.select().from(schema.issue).where(eq(schema.issue.projectId, projectId));
    expect(issueRows).toHaveLength(4);
    const rowFor = (key: string) => issueRows.find((r) => r.id === ids.get(key));
    expect(rowFor("JRUN-1")?.parentId).toBe(ids.get("JRUN-2"));

    const links = await admin.select().from(schema.issueLink).where(eq(schema.issueLink.fromIssueId, ids.get("JRUN-3")!));
    expect(links).toEqual([expect.objectContaining({ toIssueId: ids.get("JRUN-4"), type: "blocks" })]);

    const sprints = await admin.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId));
    expect(sprints.map((s) => [s.name, s.state]).sort()).toEqual([
      ["Sprint 1", "closed"],
      ["Sprint 2", "active"],
      ["Sprint 3", "future"],
    ]);
    const sprintName = (sprintId: string | null) => sprints.find((s) => s.id === sprintId)?.name;
    expect(sprintName(rowFor("JRUN-1")!.sprintId)).toBe("Sprint 2");

    // Start snapshot for the active sprint, complete snapshot for the closed one. None for the future sprint.
    const snaps = await admin.select().from(schema.sprintSnapshot).where(inArray(schema.sprintSnapshot.sprintId, sprints.map((s) => s.id)));
    expect(snaps.map((s) => `${sprintName(s.sprintId)}:${s.kind}`).sort()).toEqual(["Sprint 1:complete", "Sprint 2:start"]);

    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, importRunId));
    expect(run).toMatchObject({ status: "completed", migrationId, source: "jira", dryRun: false });
    expect(run!.counts).toMatchObject({ issuesCreated: 4, parentLinksResolved: 1, linksCreated: 1 });
    expect(run!.errors).toEqual([]);

    // A second full run from "synced" creates nothing new: every issue is skipped via external_ref. (A run without a mode from "synced" is a sync now.)
    const { importRunId: secondRunId } = await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId, { mode: "full" }));
    await runJiraMigrationTick(deps(), await claimOurs());

    expect(await current()).toMatchObject({ state: "synced" });
    expect(await admin.select().from(schema.issue).where(eq(schema.issue.projectId, projectId))).toHaveLength(4);
    expect(await admin.select().from(schema.issueLink).where(eq(schema.issueLink.fromIssueId, ids.get("JRUN-3")!))).toHaveLength(1);
    expect(await admin.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId))).toHaveLength(3);
    expect(await admin.select().from(schema.sprintSnapshot).where(inArray(schema.sprintSnapshot.sprintId, sprints.map((s) => s.id)))).toHaveLength(2);

    const [secondRun] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, secondRunId));
    expect(secondRun).toMatchObject({ status: "completed", migrationId });
    expect(secondRun!.counts).toMatchObject({ issuesCreated: 0, issuesSkipped: 4 });
  });

  it("if the creator has left the workspace, the tick records the failure on the migration instead of throwing", async () => {
    await withAuthorizedTenant(ctx, (tx) => requestJiraDiscovery(tx, ctx, migrationId));
    await admin.delete(schema.member).where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)));

    await runJiraMigrationTick(deps(), await claimOurs());

    const [row] = await admin.select().from(schema.jiraMigration).where(eq(schema.jiraMigration.id, migrationId));
    expect(row).toMatchObject({ state: "failed", leaseExpiresAt: null });
    expect(row!.error).toMatch(/is not a member of organization/);
  });
});

// ── fake JIRA ───────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SPRINT_1 = { id: 1, name: "Sprint 1", state: "closed", startDate: "2024-01-01T00:00:00.000Z", endDate: "2024-01-14T00:00:00.000Z", completeDate: "2024-01-14T00:00:00.000Z" };
const SPRINT_2 = { id: 2, name: "Sprint 2", state: "active", startDate: "2024-01-15T00:00:00.000Z", endDate: "2024-01-28T00:00:00.000Z" };
const SPRINT_3 = { id: 3, name: "Sprint 3", state: "future" };

const importer = { accountId: "acc-importer", displayName: "Importer", emailAddress: "test-jira-runner-user@example.com", active: true, accountType: "atlassian" };

function jiraIssue(
  key: string,
  o: {
    summary: string;
    status: string;
    category: "new" | "indeterminate" | "done";
    created: string;
    sprint: { id: number; name: string; state: string; startDate?: string; endDate?: string; completeDate?: string };
    parentKey?: string;
    blocks?: string;
  },
) {
  return {
    id: key,
    key,
    fields: {
      summary: o.summary,
      issuetype: { name: "Task", subtask: false },
      status: { name: o.status, statusCategory: { key: o.category, name: o.status } },
      assignee: null,
      reporter: importer,
      creator: importer,
      priority: { name: "Medium" },
      labels: [],
      description: null,
      created: o.created,
      ...(o.parentKey ? { parent: { key: o.parentKey } } : {}),
      issuelinks: o.blocks ? [{ type: { name: "Blocks" }, outwardIssue: { key: o.blocks } }] : [],
      comment: { total: 0, comments: [] },
      worklog: { total: 0, worklogs: [] },
      attachment: [],
      customfield_10020: [o.sprint],
    },
  };
}

// Page 1 holds JRUN-1 (child) and JRUN-3 (blocks JRUN-4). Their targets, JRUN-2
// (parent) and JRUN-4, are on page 2, so both links are deferred.
const PAGE_1 = [
  jiraIssue("JRUN-1", { summary: "Child story", status: "In Progress", category: "indeterminate", created: "2024-01-05T00:00:00.000+0000", sprint: SPRINT_2, parentKey: "JRUN-2" }),
  jiraIssue("JRUN-3", { summary: "Blocker", status: "To Do", category: "new", created: "2024-01-04T00:00:00.000+0000", sprint: SPRINT_3, blocks: "JRUN-4" }),
];
const PAGE_2 = [
  jiraIssue("JRUN-2", { summary: "Parent epic", status: "Done", category: "done", created: "2024-01-03T00:00:00.000+0000", sprint: SPRINT_1 }),
  jiraIssue("JRUN-4", { summary: "Blocked", status: "Done", category: "done", created: "2024-01-02T00:00:00.000+0000", sprint: SPRINT_1 }),
];

function fakeJira() {
  const state = { failPage2Once: false };
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname;

    if (path === "/rest/api/3/myself") return json({ accountId: "acc-importer", displayName: "Importer", emailAddress: importer.emailAddress });
    if (path === "/rest/api/3/project/JRUN") return json({ id: "20000", key: "JRUN", name: "JIRA Runner" });
    if (path === "/rest/agile/1.0/board") return json({ values: [{ id: 7, name: "Runner board", type: "scrum" }], isLast: true });
    if (path === "/rest/agile/1.0/board/7/sprint") {
      return json({ values: [SPRINT_1, SPRINT_2, SPRINT_3].map((s) => ({ ...s, originBoardId: 7 })), isLast: true });
    }
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
    if (path === "/rest/api/3/field") return json([]);
    if (path === "/rest/api/3/search/jql") {
      const token = url.searchParams.get("nextPageToken");
      const isLoad = url.searchParams.has("expand"); // only the load requests changelog
      if (isLoad && token === "page-2" && state.failPage2Once) {
        state.failPage2Once = false;
        return json({ errorMessages: ["Invalid nextPageToken"] }, 400);
      }
      if (!token) return json({ issues: PAGE_1, nextPageToken: "page-2", isLast: false });
      return json({ issues: PAGE_2, isLast: true });
    }
    return new Response(`no route for ${path}`, { status: 404 });
  });
  return { fetchMock, state };
}
