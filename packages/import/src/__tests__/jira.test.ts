import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject, createImportRun, withAuthorizedTenant, resolveExternalRef } from "@kompast/core";
import { id } from "@kompast/core/ids";
import { parseJiraExportFile } from "../jira/extract";
import { runJiraImport } from "../jira/load";
import type { JiraUser } from "../jira/types";
import fixture from "./fixtures/jira-demo-project.json";

describe("JIRA importer (golden fixture)", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-jira-import-org";
  const userId = "test-jira-import-user";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.externalRef).where(eq(schema.externalRef.organizationId, orgId));
    await admin.delete(schema.importRun).where(eq(schema.importRun.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Import Test Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Importer", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
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
    const { projectId, boardId } = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, key: "demo", name: "Demo", actorUserId: userId }));
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
    const { projectId, boardId } = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, key: "demo2", name: "Demo 2", actorUserId: userId }));
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
    expect(demo1?.labels).toEqual(["backend"]);
    expect(demo1?.estimateSeconds).toBe(7200);
    expect(demo1?.customFields).toEqual({ jira: { originalKey: "DEMO-1", fixVersions: ["1.0"], components: ["API"] } });
    expect(demo1?.createdAt).toEqual(new Date("2021-01-01T00:00:00.000+0000"));
    expect(demo1?.origin).toBe("import");

    const [demo3] = await admin.select().from(schema.issue).where(eq(schema.issue.id, demo3Ref!.entityId));
    expect(demo3?.parentId).toBe(demo1Ref!.entityId);

    const comments = await admin.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, demo1Ref!.entityId));
    expect(comments).toHaveLength(1);
    expect((comments[0]!.bodyJson as { text: string }).text).toBe("First comment");

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
    const automationEvents = await admin.select().from(schema.automationEvent).where(eq(schema.automationEvent.organizationId, orgId));
    expect(automationEvents).toHaveLength(0);
  });

  it("running the same import twice is idempotent — the second run skips every issue via external_ref, creating nothing new", async () => {
    const { projectId, boardId } = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, key: "demo3", name: "Demo 3", actorUserId: userId }));
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
    const comments = await admin.select().from(schema.issueComment);
    expect(comments).toHaveLength(1);
  });
});
