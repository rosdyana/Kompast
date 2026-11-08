import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, inArray } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject, createImportRun, withAuthorizedTenant, resolveExternalRef, createSprint, startSprint } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { parseJiraExportFile } from "../jira/extract";
import { runJiraImport } from "../jira/load";
import type { JiraIssue, JiraSprint, JiraUser } from "../jira/types";
import fixture from "./fixtures/jira-demo-project.json";

describe("JIRA importer (golden fixture)", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL!, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-jira-import-org";
  const userId = "test-jira-import-user";
  const teamId = "test-jira-import-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
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
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Import Test Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Importer", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
    // The fixture user must belong to the team that owns the project, or
    // team-scoped RLS (packages/db/rls.sql) hides it from them.
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  const resolveUserId = (_: JiraUser | null) => null; // no directory sync in this test — everything falls back to actorUserId

  it("parseJiraExportFile reads the fixture's 3 issues", () => {
    const issues = parseJiraExportFile(fixture);
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.key)).toEqual(["DEMO-1", "DEMO-2", "DEMO-3"]);
  });

  it("dry-run reports the status/type mapping without writing any issue", async () => {
    const { projectId, boardId } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "demo", name: "Demo", actorUserId: userId }),
    );
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: true, config: {}, createdBy: userId }),
    );
    const issues = parseJiraExportFile(fixture);

    const report = await withAuthorizedTenant(ctx, (tx) =>
      runJiraImport(tx, issues, { organizationId: orgId, projectId, boardId, importRunId, actorUserId: userId, dryRun: true, resolveUserId }),
    );

    expect(report.counts.issuesCreated).toBe(0);
    expect(report.statusMapping.find((s) => s.jiraStatusName === "Code Review")).toMatchObject({ category: "in_progress", matchedExistingStatusId: null });
    expect(report.statusMapping.find((s) => s.jiraStatusName === "To Do")?.matchedExistingStatusId).not.toBeNull();
    expect(report.statusMapping.find((s) => s.jiraStatusName === "Done")?.matchedExistingStatusId).not.toBeNull();
    expect(report.typeMapping.find((t) => t.jiraTypeName === "Improvement")).toMatchObject({ matchedExistingTypeId: null });
    expect(report.typeMapping.find((t) => t.jiraTypeName === "Subtask")?.matchedExistingTypeId).not.toBeNull();

    const issueRows = await admin.select().from(schema.issue).where(eq(schema.issue.projectId, projectId));
    expect(issueRows).toHaveLength(0);
  });

  it("a real run creates issues, backfills parent linkage, comments, worklogs, links, changelog transitions, and preserves customFields", async () => {
    const { projectId, boardId } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "demo2", name: "Demo 2", actorUserId: userId }),
    );
    const { importRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }),
    );
    const issues = parseJiraExportFile(fixture);

    const report = await withAuthorizedTenant(ctx, (tx) =>
      runJiraImport(tx, issues, { organizationId: orgId, projectId, boardId, importRunId, actorUserId: userId, dryRun: false, jiraBaseUrl: "https://demo.atlassian.net", resolveUserId }),
    );

    expect(report.errors).toEqual([]);
    expect(report.counts.issuesCreated).toBe(3);
    expect(report.counts.statusesCreated).toBe(1); // Code Review
    expect(report.counts.typesCreated).toBe(1); // Improvement
    expect(report.counts.commentsCreated).toBe(1);
    expect(report.counts.worklogsCreated).toBe(1);
    expect(report.counts.linksCreated).toBe(1);
    expect(report.counts.parentLinksResolved).toBe(1);
    expect(report.counts.historicalTransitionsRecorded).toBe(1);

    const demo1Ref = await withAuthorizedTenant(ctx, (tx) => resolveExternalRef(tx, orgId, "jira", "DEMO-1"));
    const demo2Ref = await withAuthorizedTenant(ctx, (tx) => resolveExternalRef(tx, orgId, "jira", "DEMO-2"));
    const demo3Ref = await withAuthorizedTenant(ctx, (tx) => resolveExternalRef(tx, orgId, "jira", "DEMO-3"));
    expect(demo1Ref?.sourceUrl).toBe("https://demo.atlassian.net/browse/DEMO-1");

    const [demo1] = await admin.select().from(schema.issue).where(eq(schema.issue.id, demo1Ref!.entityId));
    expect(demo1?.title).toBe("Parent story");
    expect(demo1?.priority).toBe("high");
    // Without a mapping the priorities still resolve against the project's own levels: nothing lands on a JIRA-only key.
    const priorities = await admin.select({ priority: schema.issue.priority }).from(schema.issue).where(eq(schema.issue.projectId, projectId));
    expect(priorities.every((r) => ["very_low", "low", "medium", "high", "critical"].includes(r.priority))).toBe(true);
    expect(demo1?.labels).toEqual(["backend"]);
    expect(demo1?.estimateSeconds).toBe(7200);
    expect(demo1?.customFields).toEqual({ jira: { originalKey: "DEMO-1", fixVersions: ["1.0"], components: ["API"] } });
    expect(demo1?.createdAt).toEqual(new Date("2021-01-01T00:00:00.000+0000"));
    expect(demo1?.origin).toBe("import");

    const [demo3] = await admin.select().from(schema.issue).where(eq(schema.issue.id, demo3Ref!.entityId));
    expect(demo3?.parentId).toBe(demo1Ref!.entityId);

    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, demo1Ref!.entityId));
    expect(comments).toHaveLength(1);
    // A plain-string body becomes one BlockNote paragraph (the body is stored as Block[] since the ADF converter landed).
    expect(comments[0]!.bodyJson).toEqual([expect.objectContaining({ type: "paragraph", content: [{ type: "text", text: "First comment", styles: {} }] })]);

    const worklogs = await admin.select().from(schema.worklog).where(eq(schema.worklog.issueId, demo1Ref!.entityId));
    expect(worklogs).toHaveLength(1);
    expect(worklogs[0]?.seconds).toBe(3600);

    const links = await admin.select().from(schema.issueLink).where(eq(schema.issueLink.fromIssueId, demo1Ref!.entityId));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ toIssueId: demo2Ref!.entityId, type: "blocks" });

    const history = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, demo1Ref!.entityId));
    const statusHistory = history.find((h) => h.field === "status");
    expect(statusHistory).toMatchObject({ fromValue: statusHistory!.fromValue, origin: "import" });

    // No notifications/automation noise from a bulk historical import.
    const notifications = await admin.select().from(schema.notification).where(eq(schema.notification.organizationId, orgId));
    expect(notifications).toHaveLength(0);
    const automationEvents = await admin.select().from(schema.automationWorkflowEvent).where(eq(schema.automationWorkflowEvent.organizationId, orgId));
    expect(automationEvents).toHaveLength(0);
  });

  it("running the same import twice is idempotent — the second run skips every issue via external_ref, creating nothing new", async () => {
    const { projectId, boardId } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "demo3", name: "Demo 3", actorUserId: userId }),
    );
    const { importRunId: firstRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }),
    );
    const issues = parseJiraExportFile(fixture);

    await withAuthorizedTenant(ctx, (tx) =>
      runJiraImport(tx, issues, { organizationId: orgId, projectId, boardId, importRunId: firstRunId, actorUserId: userId, dryRun: false, resolveUserId }),
    );

    const { importRunId: secondRunId } = await withAuthorizedTenant(ctx, (tx) =>
      createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }),
    );
    const secondReport = await withAuthorizedTenant(ctx, (tx) =>
      runJiraImport(tx, issues, { organizationId: orgId, projectId, boardId, importRunId: secondRunId, actorUserId: userId, dryRun: false, resolveUserId }),
    );

    expect(secondReport.counts.issuesCreated).toBe(0);
    expect(secondReport.counts.issuesSkipped).toBe(3);
    // No duplicate statuses/types either — the second run's mapping finds everything already matches.
    expect(secondReport.counts.statusesCreated).toBe(0);
    expect(secondReport.counts.typesCreated).toBe(0);

    const issueRows = await admin.select().from(schema.issue).where(eq(schema.issue.projectId, projectId));
    expect(issueRows).toHaveLength(3);

    // Passes 3-6 (comments/worklogs/links/attachments/changelog) only run for
    // issues newly created THIS run (see load.ts's newlyCreatedKeys guard) —
    // a re-run must not duplicate the one comment the fixture has.
    // Scoped to this project's issues: an unfiltered select counts every
    // comment in the shared test database (other test files running in
    // parallel, seeded demo data), which made this flaky.
    const comments = await admin
      .select()
      .from(schema.issueComment)
      .where(inArray(schema.issueComment.issueId, issueRows.map((i) => i.id)));
    expect(comments).toHaveLength(1);
  });

  describe("sprints", () => {
    const closed40: JiraSprint = { id: 140, name: "DEMO Sprint 40", state: "closed", startDate: "2026-09-01T00:00:00.000Z", endDate: "2026-09-15T00:00:00.000Z", completeDate: "2026-09-15T00:00:00.000Z" };
    const closed41: JiraSprint = { id: 141, name: "DEMO Sprint 41", state: "closed", startDate: "2026-09-15T00:00:00.000Z", endDate: "2026-09-29T00:00:00.000Z", completeDate: "2026-09-29T00:00:00.000Z" };
    const active42: JiraSprint = { id: 142, name: "DEMO Sprint 42", state: "active", goal: "Ship it", startDate: "2026-10-27T00:00:00.000Z", endDate: "2026-11-10T00:00:00.000Z" };
    const future43: JiraSprint = { id: 143, name: "DEMO Sprint 43", state: "future" };
    const futureNoNumber: JiraSprint = { id: 144, name: "Hardening", state: "future" };

    const statusOf = (name: string, key: "new" | "indeterminate" | "done") => ({ name, statusCategory: { key, name } });
    function jiraIssue(key: string, status: ReturnType<typeof statusOf>, sprints: JiraSprint[] | null): JiraIssue {
      return {
        id: key,
        key,
        fields: {
          summary: key,
          issuetype: { name: "Task", subtask: false },
          status,
          assignee: null,
          reporter: null,
          priority: null,
          labels: [],
          description: null,
          created: "2026-08-20T00:00:00.000+0000",
          // The Sprint custom field's id varies per site — the importer finds it by shape.
          customfield_10020: sprints,
        } as JiraIssue["fields"],
      };
    }
    const done = statusOf("Done", "done");
    const inProgress = statusOf("In Progress", "indeterminate");
    const todo = statusOf("To Do", "new");
    const sprintIssues = [
      jiraIssue("SPR-1", done, [closed40]), // finished in sprint 40
      jiraIssue("SPR-2", inProgress, [closed40, closed41, active42]), // carried 40 -> 41 -> 42
      jiraIssue("SPR-3", todo, [future43]),
      jiraIssue("SPR-4", todo, null), // backlog, never in a sprint
      jiraIssue("SPR-5", todo, [closed41]), // not finished in 41, went back to backlog
      jiraIssue("SPR-6", todo, [futureNoNumber]),
    ];

    async function setup(key: string) {
      const { projectId, boardId } = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId }));
      const { importRunId } = await withAuthorizedTenant(ctx, (tx) => createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }));
      return { projectId, boardId, importRunId };
    }
    async function issueByKey(key: string) {
      const ref = await withAuthorizedTenant(ctx, (tx) => resolveExternalRef(tx, orgId, "jira", key));
      const [row] = await admin.select().from(schema.issue).where(eq(schema.issue.id, ref!.entityId));
      return row!;
    }

    it("dry run plans the sprints with JIRA's numbers and writes nothing", async () => {
      const { projectId, boardId, importRunId } = await setup("sprdry");
      const report = await withAuthorizedTenant(ctx, (tx) => runJiraImport(tx, sprintIssues, { organizationId: orgId, projectId, boardId, importRunId, actorUserId: userId, dryRun: true, resolveUserId }));
      expect(report.sprintMapping.map((m) => [m.jiraSprintName, m.state, m.number, m.action])).toEqual([
        ["DEMO Sprint 40", "closed", 40, "create"],
        ["DEMO Sprint 41", "closed", 41, "create"],
        ["DEMO Sprint 42", "active", 42, "create"],
        ["DEMO Sprint 43", "future", 43, "create"],
        ["Hardening", "future", 44, "create"],
      ]);
      expect(await admin.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId))).toHaveLength(0);
    });

    it("imports closed, active and future sprints with their numbers, and puts each issue where JIRA has it", async () => {
      const { projectId, boardId, importRunId } = await setup("sprrun");
      const report = await withAuthorizedTenant(ctx, (tx) => runJiraImport(tx, sprintIssues, { organizationId: orgId, projectId, boardId, importRunId, actorUserId: userId, dryRun: false, resolveUserId }));
      expect(report.errors).toEqual([]);
      expect(report.counts.sprintsCreated).toBe(5);
      expect(report.counts.issuesInBacklog).toBe(2); // SPR-4, SPR-5

      const sprints = await admin.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId));
      const byNumber = new Map(sprints.map((s) => [s.number, s]));
      expect(byNumber.get(40)).toMatchObject({ name: "DEMO Sprint 40", state: "closed", endAt: new Date("2026-09-15T00:00:00.000Z") });
      expect(byNumber.get(41)?.state).toBe("closed");
      expect(byNumber.get(42)).toMatchObject({ name: "DEMO Sprint 42", state: "active", goal: "Ship it", startAt: new Date("2026-10-27T00:00:00.000Z") });
      expect(byNumber.get(43)?.state).toBe("future");
      expect(byNumber.get(44)).toMatchObject({ name: "Hardening", state: "future" });

      expect((await issueByKey("SPR-1")).sprintId).toBe(byNumber.get(40)!.id);
      expect((await issueByKey("SPR-2")).sprintId).toBe(byNumber.get(42)!.id);
      expect((await issueByKey("SPR-3")).sprintId).toBe(byNumber.get(43)!.id);
      expect((await issueByKey("SPR-4")).sprintId).toBeNull();
      expect((await issueByKey("SPR-5")).sprintId).toBeNull();
      expect((await issueByKey("SPR-6")).sprintId).toBe(byNumber.get(44)!.id);

      // SPR-2's carry-over history: off 40 and 41 when they closed, still on 42.
      const spr2 = await issueByKey("SPR-2");
      const memberships = await admin.select().from(schema.sprintIssue).where(eq(schema.sprintIssue.issueId, spr2.id));
      const bySprint = new Map(memberships.map((m) => [m.sprintId, m]));
      expect(bySprint.get(byNumber.get(40)!.id)?.removedAt).toEqual(new Date("2026-09-15T00:00:00.000Z"));
      expect(bySprint.get(byNumber.get(41)!.id)?.removedAt).toEqual(new Date("2026-09-29T00:00:00.000Z"));
      expect(bySprint.get(byNumber.get(42)!.id)?.removedAt).toBeNull();

      // Closed sprints get a "complete" snapshot so velocity history works.
      const snaps = await admin.select().from(schema.sprintSnapshot).where(inArray(schema.sprintSnapshot.sprintId, sprints.map((s) => s.id)));
      const snap40 = snaps.find((s) => s.sprintId === byNumber.get(40)!.id);
      expect(snap40).toMatchObject({ kind: "complete", scopeIssueCount: 2, completedIssueCount: 1 });
      expect(snaps.find((s) => s.sprintId === byNumber.get(42)!.id)?.kind).toBe("start");

      // Re-running creates no duplicate sprints.
      const { importRunId: secondRunId } = await withAuthorizedTenant(ctx, (tx) => createImportRun(tx, { organizationId: orgId, projectId, source: "jira", dryRun: false, config: {}, createdBy: userId }));
      const second = await withAuthorizedTenant(ctx, (tx) => runJiraImport(tx, sprintIssues, { organizationId: orgId, projectId, boardId, importRunId: secondRunId, actorUserId: userId, dryRun: false, resolveUserId }));
      expect(second.counts.sprintsCreated).toBe(0);
      expect(second.sprintMapping.every((m) => m.action === "already-imported")).toBe(true);
      expect(await admin.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId))).toHaveLength(5);
    });

    it("puts JIRA's active sprint issues into the board's existing active sprint, and skips taken numbers", async () => {
      const { projectId, boardId, importRunId } = await setup("sprmerge");
      const { sprintId: existingActiveId } = await withAuthorizedTenant(ctx, async (tx) => {
        await createSprint(tx, { organizationId: orgId, boardId, number: 41 }); // number 41 already taken
        const created = await createSprint(tx, { organizationId: orgId, boardId, number: 7 });
        await startSprint(tx, { sprintId: created.sprintId, actorId: userId });
        return created;
      });

      const report = await withAuthorizedTenant(ctx, (tx) => runJiraImport(tx, sprintIssues, { organizationId: orgId, projectId, boardId, importRunId, actorUserId: userId, dryRun: false, resolveUserId }));
      expect(report.errors).toEqual([]);
      const active = report.sprintMapping.find((m) => m.jiraSprintId === 142);
      expect(active).toMatchObject({ action: "existing-active", kompastSprintId: existingActiveId, number: 7 });
      // 41 was taken, so JIRA's 41 gets the next free number (42 merged into the existing active sprint, so it isn't created).
      expect(report.sprintMapping.find((m) => m.jiraSprintId === 141)?.number).toBe(44);
      expect(report.sprintMapping.find((m) => m.jiraSprintId === 144)?.number).toBe(45);
      expect((await issueByKey("SPR-2")).sprintId).toBe(existingActiveId);

      const activeSprints = await admin.select().from(schema.sprint).where(eq(schema.sprint.boardId, boardId));
      expect(activeSprints.filter((s) => s.state === "active")).toHaveLength(1);
    });
  });
});
