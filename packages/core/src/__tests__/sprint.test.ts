import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject, setSprintMinutesTemplate, setSprintRetroTemplate } from "../project";
import { createIssue } from "../issue";
import { createPage, getSprintMinutesPage } from "../page";
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
  updateSprint,
  getSprintRetroPage,
  getOrCreateSprintRetroPage,
  reorderSprintIssue,
} from "../sprint";

describe("sprint lifecycle", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-sprint-org";
  const userId = "test-sprint-user";
  const teamId = "test-sprint-team";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Sprint Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  const ctx = { userId, organizationId: orgId };

  async function seedProject() {
    return withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "spr", name: "Sprint Test", actorUserId: userId }));
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

  it("auto-numbers sprints sequentially per board, independent of other boards", async () => {
    const { boardId } = await seedProject();
    const { sprintId: s1, number: n1 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint A" }));
    const { sprintId: s2, number: n2 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint B" }));
    expect(n1).toBe(1);
    expect(n2).toBe(2);
    expect(s1).not.toBe(s2);

    const { boardId: otherBoardId } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "spr2", name: "Sprint Test 2", actorUserId: userId }),
    );
    const { number: otherN1 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId: otherBoardId, name: "Other Sprint" }));
    expect(otherN1).toBe(1);
  });

  it("an explicit starting number seeds the sequence for later auto-numbered sprints", async () => {
    const { boardId } = await seedProject();
    const { number: first } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, number: 42 }));
    const { number: second } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId }));
    expect(first).toBe(42);
    expect(second).toBe(43);
  });

  it("defaults a sprint's name to 'Sprint {number}' when no name is given", async () => {
    const { boardId } = await seedProject();
    const { sprintId, number } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId }));
    const sprint = await withAuthorizedTenant(ctx, (tx) => getSprint(tx, sprintId));
    expect(sprint!.name).toBe(`Sprint ${number}`);
  });

  it("rejects an explicit number that collides with an existing sprint on the same board", async () => {
    const { boardId } = await seedProject();
    await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, number: 1 }));
    await expect(withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, number: 1 }))).rejects.toThrow();
  });

  it("updateSprint renames a sprint, and rejects an empty name", async () => {
    const { boardId } = await seedProject();
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Original" }));

    await withAuthorizedTenant(ctx, (tx) => updateSprint(tx, { sprintId, name: "Renamed" }));
    const sprint = await withAuthorizedTenant(ctx, (tx) => getSprint(tx, sprintId));
    expect(sprint!.name).toBe("Renamed");

    await expect(withAuthorizedTenant(ctx, (tx) => updateSprint(tx, { sprintId, name: "   " }))).rejects.toThrow(/empty/i);
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

  it("creates a linked, titled minutes page from the project's template when actorUserId is given", async () => {
    const { projectId, boardId } = await seedProject();
    const template = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, projectId, title: "Sprint Minutes Template", type: "template", actorUserId: userId }));
    await withAuthorizedTenant(ctx, (tx) => setSprintMinutesTemplate(tx, projectId, template.id));

    const { sprintId, number } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, actorUserId: userId }));

    const minutes = await withAuthorizedTenant(ctx, (tx) => getSprintMinutesPage(tx, sprintId));
    expect(minutes).not.toBeNull();
    expect(minutes!.sprintId).toBe(sprintId);
    expect(minutes!.title).toBe(`Sprint ${number} — Sprint Action`);
  });

  it("falls back to a blank minutes page when the project has no template (actorUserId given); creates none at all when actorUserId is omitted", async () => {
    const { boardId: boardWithoutTemplate } = await seedProject();
    const { sprintId: s1, number: n1 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId: boardWithoutTemplate, actorUserId: userId }));
    const minutes1 = await withAuthorizedTenant(ctx, (tx) => getSprintMinutesPage(tx, s1));
    expect(minutes1).not.toBeNull();
    expect(minutes1!.sprintId).toBe(s1);
    expect(minutes1!.title).toBe(`Sprint ${n1} — Sprint Action`);

    const { projectId, boardId } = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "sprg", name: "Sprint Test G", actorUserId: userId }));
    const template = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, projectId, title: "Sprint Minutes Template", type: "template", actorUserId: userId }));
    await withAuthorizedTenant(ctx, (tx) => setSprintMinutesTemplate(tx, projectId, template.id));
    const { sprintId: s2 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId })); // no actorUserId
    expect(await withAuthorizedTenant(ctx, (tx) => getSprintMinutesPage(tx, s2))).toBeNull();
  });

  it("falls back to a blank minutes page when the configured template page no longer exists", async () => {
    const { projectId, boardId } = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "sprh", name: "Sprint Test H", actorUserId: userId }));
    await withAuthorizedTenant(ctx, (tx) => setSprintMinutesTemplate(tx, projectId, "nonexistent-template-page-id"));

    const { sprintId, number } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, actorUserId: userId }));

    const minutes = await withAuthorizedTenant(ctx, (tx) => getSprintMinutesPage(tx, sprintId));
    expect(minutes).not.toBeNull();
    expect(minutes!.title).toBe(`Sprint ${number} — Sprint Action`);
  });

  it("creates a linked, titled retrospective page (via sprint.retroPageId, not page.sprintId) from the project's template when actorUserId is given", async () => {
    const { projectId, boardId } = await seedProject();
    const template = await withAuthorizedTenant(ctx, (tx) =>
      createPage(tx, { organizationId: orgId, projectId, title: "Sprint Retrospective Template", type: "template", actorUserId: userId }),
    );
    await withAuthorizedTenant(ctx, (tx) => setSprintRetroTemplate(tx, projectId, template.id));

    const { sprintId, number } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, actorUserId: userId }));

    const retro = await withAuthorizedTenant(ctx, (tx) => getSprintRetroPage(tx, sprintId));
    expect(retro).not.toBeNull();
    expect(retro!.title).toBe(`Sprint ${number} — Retrospective`);
    expect(retro!.sprintId).toBeNull(); // linked via sprint.retroPageId, distinct from the Sprint Action doc's page.sprintId linkage

    const sprint = await withAuthorizedTenant(ctx, (tx) => getSprint(tx, sprintId));
    expect(sprint!.retroPageId).toBe(retro!.id);
  });

  it("falls back to a blank retrospective page when the project has no template; creates none at creation time when actorUserId is omitted", async () => {
    const { boardId: boardWithoutTemplate } = await seedProject();
    const { sprintId: s1, number: n1 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId: boardWithoutTemplate, actorUserId: userId }));
    const retro1 = await withAuthorizedTenant(ctx, (tx) => getSprintRetroPage(tx, s1));
    expect(retro1).not.toBeNull();
    expect(retro1!.title).toBe(`Sprint ${n1} — Retrospective`);

    const { sprintId: s2 } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId: boardWithoutTemplate })); // no actorUserId
    expect(await withAuthorizedTenant(ctx, (tx) => getSprintRetroPage(tx, s2))).toBeNull();
  });

  it("getOrCreateSprintRetroPage lazily backfills a retro page for a sprint that predates this feature (created with no actorUserId)", async () => {
    const { boardId } = await seedProject();
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId })); // no actorUserId — no retro page yet
    expect(await withAuthorizedTenant(ctx, (tx) => getSprintRetroPage(tx, sprintId))).toBeNull();

    const created = await withAuthorizedTenant(ctx, (tx) => getOrCreateSprintRetroPage(tx, sprintId, userId));
    expect(created.id).not.toBeNull();

    // Idempotent: a second call returns the same page rather than creating another.
    const again = await withAuthorizedTenant(ctx, (tx) => getOrCreateSprintRetroPage(tx, sprintId, userId));
    expect(again.id).toBe(created.id);
  });

  it("reorderSprintIssue moves an issue's manual review rank without touching the global issue.rank used by the backlog/board", async () => {
    const { projectId, boardId, issueTypes, statuses } = await seedProject();
    const { sprintId } = await withAuthorizedTenant(ctx, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));
    const issueA = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[0]!.id));
    const issueB = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[0]!.id));
    const issueC = await withAuthorizedTenant(ctx, (tx) => seedIssue(tx, projectId, issueTypes[0]!.id, statuses[0]!.id));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, issueA));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, issueB));
    await withAuthorizedTenant(ctx, (tx) => addIssueToSprint(tx, sprintId, issueC));

    const bySprintRank = async () => {
      const rows = await admin
        .select({ issueId: schema.sprintIssue.issueId, rank: schema.sprintIssue.rank })
        .from(schema.sprintIssue)
        .where(eq(schema.sprintIssue.sprintId, sprintId));
      return rows.sort((a, b) => (a.rank! < b.rank! ? -1 : 1)).map((r) => r.issueId);
    };

    expect(await bySprintRank()).toEqual([issueA, issueB, issueC]);

    // Move C to the front.
    await withAuthorizedTenant(ctx, (tx) => reorderSprintIssue(tx, { sprintId, issueId: issueC, beforeIssueId: undefined, afterIssueId: issueA }));
    expect(await bySprintRank()).toEqual([issueC, issueA, issueB]);

    // The global issue.rank (backlog/board order) must be untouched by a sprint-review reorder.
    const globalRanks = await admin.select({ id: schema.issue.id, rank: schema.issue.rank }).from(schema.issue).where(eq(schema.issue.projectId, projectId));
    const originalOrder = [issueA, issueB, issueC];
    const sortedByGlobalRank = [...globalRanks].sort((a, b) => (a.rank < b.rank ? -1 : 1)).map((r) => r.id);
    expect(sortedByGlobalRank).toEqual(originalOrder);
  });
});
