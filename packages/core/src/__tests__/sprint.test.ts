import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import {
  createSprint,
  listSprints,
  getSprint,
  listBacklogIssues,
  listSprintIssues,
  addIssueToSprint,
  removeIssueFromSprint,
  startSprint,
  completeSprint,
  getSprintReport,
} from "../sprint";

describe("sprint lifecycle", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-sprint-org";
  const userId = "test-sprint-user";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Sprint Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  const ctx = { userId, organizationId: orgId };

  async function seedProject() {
    return withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, key: "spr", name: "Sprint Test", actorUserId: userId }));
  }

  async function seedIssue(tx: Parameters<typeof createIssue>[0], projectId: string, typeId: string, statusId: string, storyPoints?: number) {
    const created = await createIssue(tx, { organizationId: orgId, projectId, typeId, statusId, title: "Issue", reporterId: userId, storyPoints });
    return created.issueId;
  }

  it("creates a sprint in the future state and lists it for its board", async () => {
    const { boardId } = await seedProject();
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1", cycle: "2w" }));

    const sprints = await withAuthorizedTenant(ctx, (tx) => listSprints(tx, boardId));
    expect(sprints).toHaveLength(1);
    expect(sprints[0]!.id).toBe(sprintId);
    expect(sprints[0]!.state).toBe("future");
  });

  it("adds an issue to a sprint (out of the backlog) and back again", async () => {
    const { projectId, boardId, issueTypes, statuses } = await seedProject();
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));
    const issueId = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[0]!.id, 3));

    let backlog = await withAuthorizedTenant(ctx, (tx) => listBacklogIssues(tx, projectId));
    expect(backlog.map((i) => i.id)).toContain(issueId);

    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, issueId));

    backlog = await withAuthorizedTenant(ctx, (tx) => listBacklogIssues(tx, projectId));
    expect(backlog.map((i) => i.id)).not.toContain(issueId);

    const members = await withAuthorizedTenant(ctx, (tx) => listSprintIssues(tx, sprintId));
    expect(members.map((i) => i.id)).toEqual([issueId]);

    await withAuthorizedTenant(ctx, (tx) => removeIssueFromSprint(tx, issueId));
    backlog = await withAuthorizedTenant(ctx, (tx) => listBacklogIssues(tx, projectId));
    expect(backlog.map((i) => i.id)).toContain(issueId);
  });

  it("refuses to start a second sprint while one is already active on the same board", async () => {
    const { boardId } = await seedProject();
    const { sprintId: s1 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));
    const { sprintId: s2 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 2" }));

    await withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId: s1, actorId: userId }));

    await expect(withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId: s2, actorId: userId }))).rejects.toThrow(/already has an active sprint/i);
  });

  it("starting a sprint marks its current issues plannedAtStart and snapshots scope", async () => {
    const { projectId, boardId, issueTypes, statuses } = await seedProject();
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1", cycle: "1w" }));
    const issueId = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[0]!.id, 5));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, issueId));

    await withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId, actorId: userId }));

    const sprint = await withAuthorizedTenant(ctx, (tx) => getSprint(tx, sprintId));
    expect(sprint!.state).toBe("active");
    expect(sprint!.startAt).toBeTruthy();
    expect(sprint!.endAt).toBeTruthy();

    const [membership] = await admin.select().from(schema.sprintIssue).where(eq(schema.sprintIssue.sprintId, sprintId));
    expect(membership!.plannedAtStart).toBe(true);

    const [snapshot] = await admin
      .select()
      .from(schema.sprintSnapshot)
      .where(eq(schema.sprintSnapshot.sprintId, sprintId));
    expect(snapshot!.kind).toBe("start");
    expect(snapshot!.scopePoints).toBe(5);
  });

  it("completing a sprint carries not-done issues to the backlog and reports velocity from done points", async () => {
    const { projectId, boardId, issueTypes, statuses } = await seedProject();
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));

    const doneIssueId = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[4]!.id, 3));
    const notDoneIssueId = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[0]!.id, 2));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, doneIssueId));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, notDoneIssueId));
    await withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId, actorId: userId }));

    const result = await withAuthorizedTenant(ctx, (tx) => completeSprint(tx, { sprintId, actorId: userId }));
    expect(result).toEqual({ completedIssueCount: 1, completedPoints: 3, carriedIssueCount: 1, carriedPoints: 2, velocity: 3 });

    const sprint = await withAuthorizedTenant(ctx, (tx) => getSprint(tx, sprintId));
    expect(sprint!.state).toBe("closed");

    const backlog = await withAuthorizedTenant(ctx, (tx) => listBacklogIssues(tx, projectId));
    expect(backlog.map((i) => i.id)).toContain(notDoneIssueId);
    expect(backlog.map((i) => i.id)).not.toContain(doneIssueId);

    const [completeSnapshot] = await admin
      .select()
      .from(schema.sprintSnapshot)
      .where(and(eq(schema.sprintSnapshot.sprintId, sprintId), eq(schema.sprintSnapshot.kind, "complete")));
    expect(completeSnapshot!.completedPoints).toBe(3);
  });

  it("carries a not-done issue directly into the next sprint when carryToSprintId is given", async () => {
    const { projectId, boardId, issueTypes, statuses } = await seedProject();
    const { sprintId: s1 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));
    const { sprintId: s2 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 2" }));
    const issueId = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[0]!.id, 1));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, s1, issueId));
    await withAuthorizedTenant(ctx, (tx) => startSprint(tx, { sprintId: s1, actorId: userId }));

    await withAuthorizedTenant(ctx, (tx) => completeSprint(tx, { sprintId: s1, actorId: userId, carryToSprintId: s2 }));

    const s2Members = await withAuthorizedTenant(ctx, (tx) => listSprintIssues(tx, s2));
    expect(s2Members.map((i) => i.id)).toEqual([issueId]);
  });

  it("getSprintReport reflects live scope/completion for an active sprint", async () => {
    const { projectId, boardId, issueTypes, statuses } = await seedProject();
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));
    const issueA = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[4]!.id, 2));
    const issueB = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[2]!.id, 3));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, issueA));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, issueB));

    const report = await withAuthorizedTenant(ctx, (tx) => getSprintReport(tx, sprintId));
    expect(report).toEqual({ scopeIssueCount: 2, scopePoints: 5, completedIssueCount: 1, completedPoints: 2, remainingPoints: 3 });
  });
});
