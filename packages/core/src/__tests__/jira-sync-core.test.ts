import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb as admin, schema, eq, and } from "@kompast/db";
import { createProject } from "../project";
import { withAuthorizedTenant } from "../permissions";
import { createIssue, updateIssue } from "../issue";
import { id } from "../ids";
import {
  createJiraMigration,
  findDueJiraAutoSyncs,
  getJiraMigration,
  listJiraMigrationRuns,
  setJiraMigrationAutoSync,
  startJiraMigrationRun,
} from "../jira-migration";

/** The catch-up sync's core rules: the import-only history switch, the run mode, and the auto-sync setter. */
describe("JIRA catch-up sync (core)", () => {
  const orgId = "test-jira-sync-core-org";
  const userId = "test-jira-sync-core-user";
  const teamId = "test-jira-sync-core-team";
  const ctx = { userId, organizationId: orgId };

  let projectId: string;
  let boardId: string;
  let migrationId: string;
  let issueId: string;
  let statusId: string;
  let typeId: string;

  async function cleanup() {
    await admin.delete(schema.jiraMigration).where(eq(schema.jiraMigration.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "JIRA Sync Core Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Syncer", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "owner" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Sync Core Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });

    const project = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "jcore", name: "JIRA Sync Core", actorUserId: userId }));
    projectId = project.projectId;
    boardId = project.boardId;

    const { migrationId: mid } = await withAuthorizedTenant(ctx, (tx) =>
      createJiraMigration(tx, ctx, { projectId, boardId, siteUrl: "https://jira.example.net", email: `${userId}@example.com`, apiToken: "token", jiraProjectKey: "JCORE", jiraBoardId: 1 }),
    );
    migrationId = mid;

    const [status] = await admin.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId)).limit(1);
    const [type] = await admin.select().from(schema.issueType).where(eq(schema.issueType.projectId, projectId)).limit(1);
    statusId = status!.id;
    typeId = type!.id;
    issueId = await withAuthorizedTenant(ctx, async (tx) => {
      const created = await createIssue(tx, { organizationId: orgId, projectId, typeId, statusId, title: "Original", reporterId: userId, actorId: userId, origin: "user" } as Parameters<typeof createIssue>[1]);
      return created.issueId;
    });
  });

  afterAll(cleanup);

  it("an import-only patch with recordHistory false writes no history row, and any other origin is refused", async () => {
    const before = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issueId));
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, issueId, { title: "Synced title", actorId: userId, origin: "import", recordHistory: false }));
    const after = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issueId));
    expect(after).toHaveLength(before.length);
    const [row] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(row?.title).toBe("Synced title");

    await expect(withAuthorizedTenant(ctx, (tx) => updateIssue(tx, issueId, { title: "x", actorId: userId, recordHistory: false }))).rejects.toThrow(
      /recordHistory can only be turned off by an import/,
    );
  });

  it("a run defaults to a full import until a run has finished, then to a sync; a sync before that is refused", async () => {
    // A ready migration with a mapping, as a finished scan leaves it.
    const mapping = { statuses: [], types: [], people: [], priorities: [], attachmentMaxBytes: null };
    await admin.update(schema.jiraMigration).set({ state: "ready", mapping: mapping as never }).where(eq(schema.jiraMigration.id, migrationId));
    await expect(withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId, { mode: "sync" }))).rejects.toThrow(/finished import/);

    const first = await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));
    expect(first.mode).toBe("full");
    const [run] = await admin.select().from(schema.importRun).where(eq(schema.importRun.id, first.importRunId));
    expect(run?.config).toMatchObject({ mode: "full" });

    // A finished run: the default is now a sync, and the cursor carries the start time.
    await admin.update(schema.jiraMigration).set({ state: "synced", lastSyncedAt: new Date(Date.now() - 60_000) }).where(eq(schema.jiraMigration.id, migrationId));
    const second = await withAuthorizedTenant(ctx, (tx) => startJiraMigrationRun(tx, ctx, migrationId));
    expect(second.mode).toBe("sync");
    const m = await withAuthorizedTenant(ctx, (tx) => getJiraMigration(tx, migrationId));
    expect(m?.cursor).toMatchObject({ mode: "sync", importRunId: second.importRunId });
    expect(typeof (m?.cursor as { startedAt?: unknown } | null)?.startedAt).toBe("string");
    const runs = await withAuthorizedTenant(ctx, (tx) => listJiraMigrationRuns(tx, migrationId));
    expect(runs.map((r) => r.id)).toEqual([second.importRunId, first.importRunId]);
  });

  it("auto-sync accepts off, 15, 60 and 240 minutes only, and a due migration needs a token and a passed interval", async () => {
    await expect(withAuthorizedTenant(ctx, (tx) => setJiraMigrationAutoSync(tx, ctx, migrationId, 30 as never))).rejects.toThrow(/every 15 minutes/);
    await withAuthorizedTenant(ctx, (tx) => setJiraMigrationAutoSync(tx, ctx, migrationId, 15));
    const m = await withAuthorizedTenant(ctx, (tx) => getJiraMigration(tx, migrationId));
    expect(m?.autoSyncMinutes).toBe(15);

    await admin.update(schema.jiraMigration).set({ state: "synced", lastSyncedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.jiraMigration.id, migrationId));
    const due = await findDueJiraAutoSyncs(admin, new Date());
    expect(due.map((d) => d.id)).toContain(migrationId);

    await admin.update(schema.jiraMigration).set({ lastSyncedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(schema.jiraMigration.id, migrationId));
    expect((await findDueJiraAutoSyncs(admin, new Date())).map((d) => d.id)).not.toContain(migrationId);

    await withAuthorizedTenant(ctx, (tx) => setJiraMigrationAutoSync(tx, ctx, migrationId, null));
    const off = await admin.select().from(schema.jiraMigration).where(and(eq(schema.jiraMigration.id, migrationId)));
    expect(off[0]?.autoSyncMinutes).toBeNull();
  });
});
