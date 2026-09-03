import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema, withTenant } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { createProject } from "../project";
import { createIssue, moveIssue } from "../issue";
import { getBoard } from "../board";
import { requireMembership, requireProjectAccess, withAuthorizedTenant, ForbiddenError } from "../permissions";
import { id } from "../ids";

/**
 * Exercises the real service layer against a live Postgres — the same
 * database apps/web talks to — not mocks. Identity fixtures (org/user/
 * member) are inserted directly rather than through Better Auth's HTTP/
 * OAuth layer: packages/core's public surface is `{ userId, organizationId
 * }`, and resolving that from a real session cookie is a separate, thin
 * concern that belongs in apps/web (full OAuth-flow testing against a mock
 * IdP is explicit P9 scope, not this layer).
 *
 * `db` (imported from @kompast/db) connects as the restricted, RLS-subject
 * app role — same as production. Every read/write against project/issue/
 * issue_history therefore goes through withAuthorizedTenant()/getBoard(tx,
 * ...) with a real tx, exactly like a real request would; a bare `db.select`
 * against those tables with no workspace GUC set returns nothing, by
 * design (see packages/db/rls.sql), not because of a bug here. Fixture
 * setup/teardown on unprotected identity tables (organization/user/member)
 * uses a second, admin-connected client since those aren't RLS-scoped by
 * organization_id in the same sense.
 */
describe("project + board service layer", () => {
  const env = loadEnv();
  const admin = drizzle(postgres(env.DATABASE_ADMIN_URL, { max: 1 }));

  const orgId = "test-core-org";
  const otherOrgId = "test-core-other-org";
  const userId = "test-core-user";
  const outsiderId = "test-core-outsider";

  async function resetFixtures() {
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, outsiderId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));

    await admin.insert(schema.organization).values([
      { id: orgId, name: "Test Core Org", slug: orgId },
      { id: otherOrgId, name: "Test Core Other Org", slug: otherOrgId },
    ]);
    await admin.insert(schema.user).values([
      { id: userId, name: "Test User", email: `${userId}@example.com` },
      { id: outsiderId, name: "Outsider", email: `${outsiderId}@example.com` },
    ]);
    await admin
      .insert(schema.member)
      .values([
        { id: id("mem"), organizationId: orgId, userId, role: "member" },
        { id: id("mem"), organizationId: otherOrgId, userId, role: "member" },
      ]);
  }

  beforeEach(resetFixtures);

  afterAll(async () => {
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, outsiderId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));
  });

  it("rejects a non-member before touching any data", async () => {
    await expect(requireMembership(db, { organizationId: orgId, userId: outsiderId })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("seeds a project with default issue types, statuses, and a board whose columns map onto them", async () => {
    const result = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, key: "kpt", name: "Kompast", actorUserId: userId }),
    );

    expect(result.issueTypes).toHaveLength(5);
    expect(result.statuses).toHaveLength(5);

    // key/board reads are through withTenant() here too, matching how a
    // real request would re-read what it just wrote.
    const project = await withTenant(db, { organizationId: orgId, userId }, (tx) =>
      tx.select().from(schema.project).where(eq(schema.project.id, result.projectId)).then((r) => r[0]),
    );
    expect(project?.key).toBe("KPT");

    const columns = await admin
      .select()
      .from(schema.boardColumn)
      .where(eq(schema.boardColumn.boardId, result.boardId));
    expect(columns).toHaveLength(5);
    expect(columns.filter((c) => c.isBacklog)).toHaveLength(1);

    const board = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => getBoard(tx, result.boardId));
    expect(board.columns.map((c) => c.name)).toEqual(["Backlog", "To Do", "In Progress", "In Review", "Done"]);
  });

  it("rejects project access for a project outside the caller's operating organization", async () => {
    const { projectId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, key: "kpt2", name: "K2", actorUserId: userId }),
    );

    // `userId` IS a real member of otherOrgId — this must fail because the
    // project lives in orgId, not because of a membership gap.
    await expect(
      withAuthorizedTenant({ userId, organizationId: otherOrgId }, (tx) =>
        requireProjectAccess(tx, { organizationId: otherOrgId, userId, projectId }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("creates issues with sequential per-project keys and ranks new cards after existing ones", async () => {
    const { projectId, boardId, issueTypes, statuses } = await withAuthorizedTenant(
      { userId, organizationId: orgId },
      (tx) => createProject(tx, { organizationId: orgId, key: "kpt3", name: "K3", actorUserId: userId }),
    );
    const taskType = issueTypes.find((t) => t.name === "Task")!;
    const todoStatus = statuses.find((s) => s.name === "To Do")!;

    const first = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: taskType.id,
        statusId: todoStatus.id,
        title: "First issue",
        reporterId: userId,
      }),
    );
    const second = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: taskType.id,
        statusId: todoStatus.id,
        title: "Second issue",
        reporterId: userId,
      }),
    );

    expect(second.keySeq).toBe(first.keySeq + 1);

    const [firstRow, secondRow] = await withAuthorizedTenant({ userId, organizationId: orgId }, async (tx) => [
      (await tx.select().from(schema.issue).where(eq(schema.issue.id, first.issueId)))[0],
      (await tx.select().from(schema.issue).where(eq(schema.issue.id, second.issueId)))[0],
    ]);
    expect(secondRow!.rank > firstRow!.rank).toBe(true);

    const board = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => getBoard(tx, boardId));
    const todoColumn = board.columns.find((c) => c.name === "To Do")!;
    expect(todoColumn.issues.map((i) => i.id)).toEqual([first.issueId, second.issueId]);
  });

  it("moveIssue changes status and writes issue_history, but only on an actual status change", async () => {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(
      { userId, organizationId: orgId },
      (tx) => createProject(tx, { organizationId: orgId, key: "kpt4", name: "K4", actorUserId: userId }),
    );
    const taskType = issueTypes.find((t) => t.name === "Task")!;
    const todoStatus = statuses.find((s) => s.name === "To Do")!;
    const inProgressStatus = statuses.find((s) => s.name === "In Progress")!;

    const { issueId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: taskType.id,
        statusId: todoStatus.id,
        title: "Move me",
        reporterId: userId,
      }),
    );

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      moveIssue(tx, { issueId, toStatusId: inProgressStatus.id, actorId: userId }),
    );

    const afterMove = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      tx.select().from(schema.issue).where(eq(schema.issue.id, issueId)).then((r) => r[0]),
    );
    expect(afterMove?.statusId).toBe(inProgressStatus.id);

    const statusChanges = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      tx
        .select()
        .from(schema.issueHistory)
        .where(eq(schema.issueHistory.issueId, issueId))
        .then((rows) => rows.filter((h) => h.field === "status")),
    );
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]?.toValue).toBe(inProgressStatus.id);

    // Moving to the SAME status again must not write a second history row —
    // reordering within a column changes rank, not status.
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      moveIssue(tx, { issueId, toStatusId: inProgressStatus.id, actorId: userId }),
    );
    const statusChangesAfter = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      tx
        .select()
        .from(schema.issueHistory)
        .where(eq(schema.issueHistory.issueId, issueId))
        .then((rows) => rows.filter((h) => h.field === "status")),
    );
    expect(statusChangesAfter).toHaveLength(1);
  });
});
