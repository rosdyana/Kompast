import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, inArray } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue, moveIssue, updateIssue, recordHistoricalFieldChange } from "../issue";
import { addComment } from "../comment";
import { createSprint, addIssueToSprint, startSprint } from "../sprint";
import { logWork } from "../worklog";
import { getMyStandupActivity, getStandupDigest, type StandupActivityItem } from "../standup";
import { updateBoardSettings } from "../board";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("standup digest", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL!, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-standup-org";
  const userA = "test-standup-user-a";
  const userB = "test-standup-user-b";
  const teamId = "test-standup-team";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.id, [userA, userB]));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Standup Org", slug: orgId });
    await admin.insert(schema.user).values([
      { id: userA, name: "Alice", email: `${userA}@example.com` },
      { id: userB, name: "Bob", email: `${userB}@example.com` },
    ]);
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: userA, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: userB, role: "member" },
    ]);
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Standup Team" });
    // Both fixture users must belong to the team that owns the project, or team-scoped RLS hides it from them.
    await admin.insert(schema.teamMember).values([
      { id: `tmem-${teamId}-${userA}`, teamId, userId: userA, membershipKey: `${teamId}:${userA}` },
      { id: `tmem-${teamId}-${userB}`, teamId, userId: userB, membershipKey: `${teamId}:${userB}` },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  const ctxA = { userId: userA, organizationId: orgId };
  const DAY_MS = 24 * 60 * 60 * 1000;

  async function setupProject() {
    const { boardId, issueTypes, statuses, projectId } = await withAuthorizedTenant(ctxA, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "std", name: "Standup Test", actorUserId: userA }),
    );
    const { sprintId } = await withAuthorizedTenant(ctxA, (tx) => createSprint(tx, { organizationId: orgId, boardId, name: "Sprint 1" }));
    const statusId = (name: string) => {
      const found = statuses.find((s) => s.name === name);
      if (!found) throw new Error(`No default status named ${name}`);
      return found.id;
    };
    return { projectId, boardId, typeId: issueTypes[0]!.id, sprintId, statusId };
  }

  async function makeIssue(
    fx: Awaited<ReturnType<typeof setupProject>>,
    input: { title: string; origin?: "user" | "import"; createdAt?: Date; inSprint?: boolean },
  ): Promise<string> {
    const { issueId } = await withAuthorizedTenant(ctxA, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId: fx.projectId,
        typeId: fx.typeId,
        statusId: fx.statusId("To Do"),
        title: input.title,
        reporterId: userA,
        origin: input.origin,
        createdAt: input.createdAt,
      }),
    );
    if (input.inSprint !== false) {
      await withAuthorizedTenant(ctxA, (tx) => addIssueToSprint(tx, fx.sprintId, issueId));
    }
    return issueId;
  }

  async function digest(sprintId: string, since: Date) {
    return withAuthorizedTenant(ctxA, (tx) => getStandupDigest(tx, { sprintId, since }));
  }

  function itemsFor(byUser: Record<string, StandupActivityItem[]>, userId: string, issueId: string) {
    return (byUser[userId] ?? []).filter((i) => i.issueId === issueId);
  }

  it("collapses several status moves by one user into one item, first from and last to", async () => {
    const fx = await setupProject();
    const issueId = await makeIssue(fx, { title: "Ship the thing" });
    await withAuthorizedTenant(ctxA, (tx) => startSprint(tx, { sprintId: fx.sprintId, actorId: userA }));

    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId, toStatusId: fx.statusId("In Progress"), actorId: userA }));
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId, toStatusId: fx.statusId("Done"), actorId: userA }));

    const { byUser } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    const statusItems = itemsFor(byUser, userA, issueId).filter((i) => i.kind === "status");
    expect(statusItems).toHaveLength(1);
    expect(statusItems[0]!.fromStatus).toMatchObject({ name: "To Do", category: "todo" });
    expect(statusItems[0]!.toStatus).toMatchObject({ name: "Done", category: "done" });
    expect(statusItems[0]!.lastAt).toBeInstanceOf(Date);
  });

  it("attributes a comment to its author and counts it", async () => {
    const fx = await setupProject();
    const issueId = await makeIssue(fx, { title: "Discuss me" });
    await withAuthorizedTenant(ctxA, (tx) => addComment(tx, { issueId, authorId: userB, bodyJson: { text: "first" } }));
    await withAuthorizedTenant(ctxA, (tx) => addComment(tx, { issueId, authorId: userB, bodyJson: { text: "second" } }));

    const { byUser } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    const commented = itemsFor(byUser, userB, issueId).filter((i) => i.kind === "commented");
    expect(commented).toHaveLength(1);
    expect(commented[0]!.commentCount).toBe(2);
    expect(itemsFor(byUser, userA, issueId).filter((i) => i.kind === "commented")).toHaveLength(0);
  });

  it("merges a priority and a description change into one edited item listing both fields", async () => {
    const fx = await setupProject();
    const issueId = await makeIssue(fx, { title: "Edit me" });
    await withAuthorizedTenant(ctxA, (tx) =>
      updateIssue(tx, issueId, { priority: "highest", descriptionJson: { text: "more detail" }, actorId: userA }),
    );

    const { byUser } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    const edited = itemsFor(byUser, userA, issueId).filter((i) => i.kind === "edited");
    expect(edited).toHaveLength(1);
    expect(edited[0]!.fields).toEqual(expect.arrayContaining(["priority", "description"]));
    expect(edited[0]!.fields).toHaveLength(2);
  });

  it("excludes activity that happened before since", async () => {
    const fx = await setupProject();
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
    const issueId = await makeIssue(fx, { title: "Old news", createdAt: tenDaysAgo });
    await withAuthorizedTenant(ctxA, (tx) =>
      addComment(tx, { issueId, authorId: userB, bodyJson: { text: "ancient" }, createdAt: tenDaysAgo }),
    );

    const { byUser } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    expect(itemsFor(byUser, userA, issueId)).toHaveLength(0);
    expect(itemsFor(byUser, userB, issueId)).toHaveLength(0);
  });

  it("excludes issues that are not on the sprint", async () => {
    const fx = await setupProject();
    const onSprint = await makeIssue(fx, { title: "On the sprint" });
    const offSprint = await makeIssue(fx, { title: "Backlog only", inSprint: false });
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId: offSprint, toStatusId: fx.statusId("Done"), actorId: userA }));
    await withAuthorizedTenant(ctxA, (tx) => addComment(tx, { issueId: offSprint, authorId: userB, bodyJson: { text: "not here" } }));
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId: onSprint, toStatusId: fx.statusId("In Progress"), actorId: userA }));

    const { byUser } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    const allIssueIds = Object.values(byUser).flat().map((i) => i.issueId);
    expect(allIssueIds).toContain(onSprint);
    expect(allIssueIds).not.toContain(offSprint);
  });

  it("excludes import-origin history but keeps ordinary user activity", async () => {
    const fx = await setupProject();
    const imported = await makeIssue(fx, { title: "Imported", origin: "import" });
    await withAuthorizedTenant(ctxA, (tx) =>
      recordHistoricalFieldChange(tx, {
        issueId: imported,
        actorId: userA,
        field: "priority",
        fromValue: "medium",
        toValue: "highest",
        createdAt: new Date(),
      }),
    );
    const live = await makeIssue(fx, { title: "Live" });
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId: live, toStatusId: fx.statusId("In Progress"), actorId: userA }));

    const { byUser } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    expect(itemsFor(byUser, userA, imported)).toHaveLength(0);
    expect(itemsFor(byUser, userA, live).some((i) => i.kind === "status")).toBe(true);
  });

  it("returns an empty digest for a sprint with no issues", async () => {
    const fx = await setupProject();
    const result = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    expect(result).toEqual({ byUser: {}, didColumnNames: [], issues: {} });
  });

  async function columnNamed(boardId: string, name: string) {
    const cols = await admin.select().from(schema.boardColumn).where(eq(schema.boardColumn.boardId, boardId));
    const found = cols.find((c) => c.name === name);
    if (!found) throw new Error(`No column named ${name}`);
    return found;
  }

  it("with Did columns set, keeps only status moves into those columns and drops comments and edits", async () => {
    const fx = await setupProject();
    const doneColumn = await columnNamed(fx.boardId, "Done");
    await withAuthorizedTenant(ctxA, (tx) =>
      updateBoardSettings(tx, { projectId: fx.projectId, boardId: fx.boardId, standupDidColumnIds: [doneColumn.id] }),
    );

    // Each issue carries exactly one kind of activity, so the filter's effect is unambiguous.
    const finished = await makeIssue(fx, { title: "Finished" });
    const started = await makeIssue(fx, { title: "Started" });
    const chatty = await makeIssue(fx, { title: "Chatty" });
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId: finished, toStatusId: fx.statusId("Done"), actorId: userA }));
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId: started, toStatusId: fx.statusId("In Progress"), actorId: userA }));
    await withAuthorizedTenant(ctxA, (tx) => addComment(tx, { issueId: chatty, authorId: userA, bodyJson: { text: "thoughts" } }));
    await withAuthorizedTenant(ctxA, (tx) => updateIssue(tx, chatty, { title: "Chatty (renamed)", actorId: userA }));

    const { byUser, didColumnNames } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    expect(didColumnNames).toEqual(["Done"]);
    const aliceItems = byUser[userA] ?? [];
    expect(aliceItems.map((i) => i.issueId)).toEqual([finished]);
    expect(aliceItems[0]!.kind).toBe("status");
    expect(aliceItems[0]!.toStatus).toMatchObject({ name: "Done", category: "done" });
  });

  it("with only a stale Did column id stored, returns the full digest unchanged and no column names", async () => {
    const fx = await setupProject();
    const finished = await makeIssue(fx, { title: "Finished" });
    const started = await makeIssue(fx, { title: "Started" });
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId: finished, toStatusId: fx.statusId("Done"), actorId: userA }));
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId: started, toStatusId: fx.statusId("In Progress"), actorId: userA }));
    await withAuthorizedTenant(ctxA, (tx) => addComment(tx, { issueId: started, authorId: userA, bodyJson: { text: "note" } }));
    const since = new Date(Date.now() - DAY_MS);

    const before = await digest(fx.sprintId, since);

    // Simulates a column deleted after it was chosen: the stored id points at nothing.
    await admin.update(schema.board).set({ standupSettings: { didColumnIds: ["deleted-column-id"] } }).where(eq(schema.board.id, fx.boardId));

    const after = await digest(fx.sprintId, since);
    expect(after.byUser).toEqual(before.byUser);
    expect(after.didColumnNames).toEqual([]);
    expect(after.byUser[userA]!.map((i) => i.kind).sort()).toEqual(["commented", "created", "created", "status", "status"]);
  });
  it("leaves sprint planning and reassignment out of edits, and labels the remaining fields by key", async () => {
    const fx = await setupProject();
    const issueId = await makeIssue(fx, { title: "Plan me", inSprint: false });
    await withAuthorizedTenant(ctxA, (tx) => addIssueToSprint(tx, fx.sprintId, issueId, { actorId: userA }));
    await withAuthorizedTenant(ctxA, (tx) => updateIssue(tx, issueId, { assigneeId: userB, actorId: userA }));

    const before = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    expect(itemsFor(before.byUser, userA, issueId).filter((i) => i.kind === "edited")).toHaveLength(0);

    await withAuthorizedTenant(ctxA, (tx) => updateIssue(tx, issueId, { storyPoints: 3, actorId: userA }));
    const after = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    const edited = itemsFor(after.byUser, userA, issueId).filter((i) => i.kind === "edited");
    expect(edited).toHaveLength(1);
    expect(edited[0]!.fields).toEqual(["storyPoints"]);
  });

  it("sums logged work per person and issue", async () => {
    const fx = await setupProject();
    const issueId = await makeIssue(fx, { title: "Grind" });
    await withAuthorizedTenant(ctxA, (tx) => logWork(tx, { issueId, userId: userB, seconds: 1800 }));
    await withAuthorizedTenant(ctxA, (tx) => logWork(tx, { issueId, userId: userB, seconds: 3600 }));

    const { byUser } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    const logged = itemsFor(byUser, userB, issueId).filter((i) => i.kind === "logged");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.loggedSeconds).toBe(5400);
  });

  it("drops a status round trip that ends where it started", async () => {
    const fx = await setupProject();
    const issueId = await makeIssue(fx, { title: "Back and forth" });
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId, toStatusId: fx.statusId("In Progress"), actorId: userA }));
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId, toStatusId: fx.statusId("To Do"), actorId: userA }));

    const { byUser } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    expect(itemsFor(byUser, userA, issueId).filter((i) => i.kind === "status")).toHaveLength(0);
  });

  it("labels every sprint issue, including one whose status maps to no board column", async () => {
    const fx = await setupProject();
    const mapped = await makeIssue(fx, { title: "On a column" });
    const unmapped = await makeIssue(fx, { title: "Off the board" });
    const orphanStatusId = `test-standup-orphan-${Date.now()}`;
    await admin.insert(schema.workflowStatus).values({ id: orphanStatusId, projectId: fx.projectId, name: "Parked", category: "in_progress", color: "#888888", order: 99 });
    await admin.update(schema.issue).set({ statusId: orphanStatusId, assigneeId: userB }).where(eq(schema.issue.id, unmapped));

    const { issues } = await digest(fx.sprintId, new Date(Date.now() - DAY_MS));
    expect(issues[mapped]).toMatchObject({ projectKey: "STD", keySeq: 1, title: "On a column", statusName: "To Do", statusCategory: "todo", teamId });
    expect(issues[unmapped]).toMatchObject({ projectKey: "STD", keySeq: 2, title: "Off the board", statusName: "Parked", statusCategory: "in_progress", assigneeId: userB });
  });

  it("getMyStandupActivity returns only the caller's own work across issues, plus what they have in progress", async () => {
    const fx = await setupProject();
    const moved = await makeIssue(fx, { title: "Moved by Bob", inSprint: false });
    const othersWork = await makeIssue(fx, { title: "Alice's comment only", inSprint: false });
    const wip = await makeIssue(fx, { title: "Bob in progress", inSprint: false });
    await withAuthorizedTenant(ctxA, (tx) => moveIssue(tx, { issueId: moved, toStatusId: fx.statusId("Done"), actorId: userB }));
    await withAuthorizedTenant(ctxA, (tx) => addComment(tx, { issueId: othersWork, authorId: userA, bodyJson: { text: "mine" } }));
    await admin.update(schema.issue).set({ statusId: fx.statusId("In Progress"), assigneeId: userB }).where(eq(schema.issue.id, wip));

    const ctxB = { userId: userB, organizationId: orgId };
    const result = await withAuthorizedTenant(ctxB, (tx) => getMyStandupActivity(tx, { userId: userB, since: new Date(Date.now() - DAY_MS) }));
    expect(result.did.map((i) => [i.issueId, i.kind])).toEqual([[moved, "status"]]);
    expect(result.inProgress).toEqual([wip]);
    expect(result.issues[moved]).toMatchObject({ projectKey: "STD", title: "Moved by Bob", statusName: "Done" });
    expect(result.issues[othersWork]).toBeUndefined();
  });
});
