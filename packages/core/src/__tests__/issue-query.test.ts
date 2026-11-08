import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, schema, eq, adminDb } from "@kompast/db";
import { id } from "../ids";
import { withAuthorizedTenant } from "../permissions";
import { createProject } from "../project";
import { createIssue, archiveIssue } from "../issue";
import { queryIssues, resolveProject, resolveStatus } from "../issue-query";
import { InvalidInputError, NotFoundError } from "../errors";

/**
 * queryIssues is the one query behind MCP list_issues and the Ask Kompast
 * list_issues tool. These tests run it as a real RLS-scoped user, against two
 * projects in the caller's team, plus a workspace member outside that team.
 */
describe("packages/core/issue-query", () => {
  const orgId = "test-iq-org";
  const userId = "test-iq-user";
  const outsiderId = "test-iq-outsider";
  const teamId = "test-iq-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await db.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await db.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await db.delete(schema.user).where(eq(schema.user.id, userId));
    await db.delete(schema.user).where(eq(schema.user.id, outsiderId));
  }

  beforeEach(async () => {
    await cleanup();
    await db.insert(schema.organization).values({ id: orgId, name: "Issue Query Org", slug: orgId });
    await db.insert(schema.user).values([
      { id: userId, name: "IQ User", email: `${userId}@example.com` },
      { id: outsiderId, name: "IQ Outsider", email: `${outsiderId}@example.com` },
    ]);
    await db.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: outsiderId, role: "member" },
    ]);
    await db.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "IQ Team" });
    await db.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
  });

  afterEach(async () => {
    await cleanup();
  });

  /** Seeds: project QA with A1 (labelled, To Do), A2 (To Do), A3 (archived), A4 (In Progress); project QB with B1 (In Progress, assigned to the user). */
  async function seed() {
    const qa = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "qa", name: "QA", actorUserId: userId }));
    const qb = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "qb", name: "QB", actorUserId: userId }));
    const inProgress = (statuses: typeof qa.statuses) => statuses.find((s) => s.name === "In Progress")!;
    const todo = (statuses: typeof qa.statuses) => statuses.find((s) => s.category === "todo")!;

    const make = (
      project: typeof qa,
      title: string,
      statusId: string,
      extra: { labels?: string[]; assigneeId?: string } = {},
    ) => withAuthorizedTenant(ctx, (tx) => createIssue(tx, { organizationId: orgId, projectId: project.projectId, typeId: project.issueTypes[0]!.id, statusId, title, reporterId: userId, ...extra }));

    const a1 = await make(qa, "A1", todo(qa.statuses).id, { labels: ["urgent"] });
    const a2 = await make(qa, "A2", todo(qa.statuses).id);
    const a3 = await make(qa, "A3", todo(qa.statuses).id);
    const a4 = await make(qa, "A4", inProgress(qa.statuses).id);
    await withAuthorizedTenant(ctx, (tx) => archiveIssue(tx, a3.issueId, { actorId: userId }));
    const b1 = await make(qb, "B1", inProgress(qb.statuses).id, { assigneeId: userId });

    // Pin updatedAt so "most recently updated first" is deterministic: B1 is the newest.
    const now = Date.now();
    await adminDb.update(schema.issue).set({ updatedAt: new Date(now - 3_000) }).where(eq(schema.issue.id, a1.issueId));
    await adminDb.update(schema.issue).set({ updatedAt: new Date(now - 2_000) }).where(eq(schema.issue.id, a2.issueId));
    await adminDb.update(schema.issue).set({ updatedAt: new Date(now - 1_000) }).where(eq(schema.issue.id, a4.issueId));
    await adminDb.update(schema.issue).set({ updatedAt: new Date(now) }).where(eq(schema.issue.id, b1.issueId));

    return { qa, qb };
  }

  const titles = (rows: { issue: { title: string } }[]) => rows.map((r) => r.issue.title);

  it("with a projectKey: oldest key first, archived left out by default, keyset-paged by keySeq", async () => {
    await seed();
    const run = (filters: Parameters<typeof queryIssues>[2]) => withAuthorizedTenant(ctx, (tx) => queryIssues(tx, orgId, filters));

    const first = await run({ projectKey: "qa", limit: 2 });
    expect(titles(first.rows)).toEqual(["A1", "A2"]);
    expect(first.rows.every((r) => r.projectKey === "QA")).toBe(true);
    expect(first.nextCursor).toBe(2);

    const second = await run({ projectKey: "qa", limit: 2, cursor: 2 });
    expect(titles(second.rows)).toEqual(["A4"]);
    expect(second.nextCursor).toBeNull();

    const withArchived = await run({ projectKey: "qa", includeArchived: true });
    expect(titles(withArchived.rows)).toEqual(["A1", "A2", "A3", "A4"]);
  });

  it("with a projectKey: a status name is matched inside that project, and an unknown one is refused", async () => {
    await seed();
    const run = (filters: Parameters<typeof queryIssues>[2]) => withAuthorizedTenant(ctx, (tx) => queryIssues(tx, orgId, filters));

    const inProgress = await run({ projectKey: "qa", statusName: "in progress" });
    expect(titles(inProgress.rows)).toEqual(["A4"]);

    await expect(run({ projectKey: "qa", statusName: "Nonexistent" })).rejects.toThrow(InvalidInputError);
  });

  it("without a projectKey: issues across every visible project, most recently updated first, cursor ignored", async () => {
    await seed();
    const { rows, nextCursor } = await withAuthorizedTenant(ctx, (tx) => queryIssues(tx, orgId, { cursor: 999, limit: 10 }));

    expect(titles(rows)).toEqual(["B1", "A4", "A2", "A1"]);
    expect(rows.map((r) => r.projectKey)).toEqual(["QB", "QA", "QA", "QA"]);
    expect(nextCursor).toBeNull();
  });

  it("without a projectKey: a status name matches any project's status of that name, case-insensitively", async () => {
    await seed();
    const { rows } = await withAuthorizedTenant(ctx, (tx) => queryIssues(tx, orgId, { statusName: "IN PROGRESS" }));
    expect(titles(rows).sort()).toEqual(["A4", "B1"]);
  });

  it("without a projectKey: assignee and label filters work across projects", async () => {
    await seed();
    const byAssignee = await withAuthorizedTenant(ctx, (tx) => queryIssues(tx, orgId, { assigneeId: userId }));
    expect(titles(byAssignee.rows)).toEqual(["B1"]);

    const byLabel = await withAuthorizedTenant(ctx, (tx) => queryIssues(tx, orgId, { label: "urgent" }));
    expect(titles(byLabel.rows)).toEqual(["A1"]);
  });

  it("a workspace member outside the project's team sees no issues at all, even without a projectKey", async () => {
    await seed();
    const outsider = { userId: outsiderId, organizationId: orgId };
    const { rows } = await withAuthorizedTenant(outsider, (tx) => queryIssues(tx, orgId, {}));
    expect(rows).toEqual([]);
    await expect(withAuthorizedTenant(outsider, (tx) => queryIssues(tx, orgId, { projectKey: "qa" }))).rejects.toThrow(NotFoundError);
  });

  it("resolvers keep the caller-facing error classes the REST and MCP surfaces map to 404 / 400", async () => {
    await seed();
    await withAuthorizedTenant(ctx, async (tx) => {
      await expect(resolveProject(tx, orgId, "NOPE")).rejects.toThrow(NotFoundError);
      const qa = await resolveProject(tx, orgId, "qa");
      await expect(resolveStatus(tx, qa.id, "Nonexistent")).rejects.toThrow(InvalidInputError);
    });
  });
});
