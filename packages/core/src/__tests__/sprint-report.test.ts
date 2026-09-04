import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue, moveIssue } from "../issue";
import { createSprint, addIssueToSprint, startSprint, completeSprint } from "../sprint";
import { getBurndown, getCumulativeFlow, getVelocityHistory } from "../sprint-report";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("sprint reports", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-sprintreport-org";
  const userId = "test-sprintreport-user";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Sprint Report Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  const ctx = { userId, organizationId: orgId };

  it("getBurndown shows a flat scope line and a dropping remaining line once an issue is done", async () => {
    const { boardId, issueTypes, statuses, projectId } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, key: "brn", name: "Burndown Test", actorUserId: userId }),
    );
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1", cycle: "1w" }));

    const issueId = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Burn me down", reporterId: userId, storyPoints: 5 }).then(
        (r) => r.issueId,
      ),
    );
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, issueId));
    await withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId, actorId: userId }));

    let burndown = await withAuthorizedTenant(ctx, (tx) => getBurndown(tx, sprintId));
    expect(burndown.length).toBeGreaterThan(0);
    expect(burndown.every((p) => p.scopePoints === 5)).toBe(true);
    expect(burndown.every((p) => p.remainingPoints === 5)).toBe(true);

    await withAuthorizedTenant(ctx, (tx) => moveIssue(tx, { issueId, toStatusId: statuses[4]!.id, actorId: userId }));

    burndown = await withAuthorizedTenant(ctx, (tx) => getBurndown(tx, sprintId));
    expect(burndown.at(-1)!.remainingPoints).toBe(0);
    expect(burndown.at(-1)!.scopePoints).toBe(5);
  });

  it("getCumulativeFlow counts today's members by status category", async () => {
    const { boardId, issueTypes, statuses, projectId } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, key: "cfd", name: "CFD Test", actorUserId: userId }),
    );
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));

    const todoIssue = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Todo", reporterId: userId }).then((r) => r.issueId),
    );
    const doneIssue = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[4]!.id, title: "Done", reporterId: userId }).then((r) => r.issueId),
    );
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, todoIssue));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, doneIssue));
    await withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId, actorId: userId }));

    const cfd = await withAuthorizedTenant(ctx, (tx) => getCumulativeFlow(tx, sprintId));
    const today = cfd.at(-1)!;
    expect(today.todo).toBe(1);
    expect(today.done).toBe(1);
    expect(today.inProgress).toBe(0);
  });

  it("getVelocityHistory returns completed points from past sprints, oldest first", async () => {
    const { boardId, issueTypes, statuses, projectId } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, key: "vel", name: "Velocity Test", actorUserId: userId }),
    );

    const { sprintId: s1 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));
    const issue1 = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[4]!.id, title: "Done in s1", reporterId: userId, storyPoints: 3 }).then(
        (r) => r.issueId,
      ),
    );
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, s1, issue1));
    await withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId: s1, actorId: userId }));
    await withAuthorizedTenant(ctx, (tx) => completeSprint(tx, { sprintId: s1, actorId: userId }));

    const { sprintId: s2 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 2" }));
    const issue2 = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[4]!.id, title: "Done in s2", reporterId: userId, storyPoints: 8 }).then(
        (r) => r.issueId,
      ),
    );
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, s2, issue2));
    await withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId: s2, actorId: userId }));
    await withAuthorizedTenant(ctx, (tx) => completeSprint(tx, { sprintId: s2, actorId: userId }));

    const history = await withAuthorizedTenant(ctx, (tx) => getVelocityHistory(tx, boardId));
    expect(history).toEqual([
      { sprintId: s1, sprintName: "Sprint 1", completedPoints: 3 },
      { sprintId: s2, sprintName: "Sprint 2", completedPoints: 8 },
    ]);
  });
});
