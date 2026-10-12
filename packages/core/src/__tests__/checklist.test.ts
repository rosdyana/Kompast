import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { getBoard } from "../board";
import { addChecklistItem, deleteChecklistItem, getChecklistSummaries, listChecklistItems, moveChecklistItem, updateChecklistItem } from "../checklist";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("issue checklist", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-checklist-org";
  const userId = "test-checklist-user";
  const outsiderId = "test-checklist-outsider";
  const teamId = "test-checklist-team";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, outsiderId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Test Checklist Org", slug: orgId });
    await admin.insert(schema.user).values([
      { id: userId, name: "Test User", email: `${userId}@example.com` },
      { id: outsiderId, name: "Outsider", email: `${outsiderId}@example.com` },
    ]);
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: outsiderId, role: "member" },
    ]);
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
    await admin.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  async function seedIssue() {
    return withAuthorizedTenant(ctx, async (tx) => {
      const { projectId, boardId, issueTypes, statuses } = await createProject(tx, { organizationId: orgId, teamId, key: "chk", name: "Checklist Test", actorUserId: userId });
      const { issueId } = await createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Test issue", reporterId: userId });
      return { issueId, boardId };
    });
  }

  it("adds in order, toggles, renames, reorders and deletes items", async () => {
    const { issueId } = await seedIssue();
    const a = await withAuthorizedTenant(ctx, (tx) => addChecklistItem(tx, { issueId, text: "  Write spec  ", createdBy: userId }));
    const b = await withAuthorizedTenant(ctx, (tx) => addChecklistItem(tx, { issueId, text: "Review", createdBy: userId }));
    const c = await withAuthorizedTenant(ctx, (tx) => addChecklistItem(tx, { issueId, text: "Ship", createdBy: userId }));
    expect(a.text).toBe("Write spec");

    await withAuthorizedTenant(ctx, (tx) => updateChecklistItem(tx, { itemId: b.id, done: true, text: "Code review" }));
    await withAuthorizedTenant(ctx, (tx) => moveChecklistItem(tx, { itemId: c.id, direction: "up" }));
    // Moving the first item up is a no-op, not an error.
    await withAuthorizedTenant(ctx, (tx) => moveChecklistItem(tx, { itemId: a.id, direction: "up" }));

    let items = await withAuthorizedTenant(ctx, (tx) => listChecklistItems(tx, issueId));
    expect(items.map((i) => [i.text, i.done])).toEqual([
      ["Write spec", false],
      ["Ship", false],
      ["Code review", true],
    ]);

    await withAuthorizedTenant(ctx, (tx) => moveChecklistItem(tx, { itemId: a.id, direction: "down" }));
    await withAuthorizedTenant(ctx, (tx) => deleteChecklistItem(tx, c.id));
    items = await withAuthorizedTenant(ctx, (tx) => listChecklistItems(tx, issueId));
    expect(items.map((i) => i.text)).toEqual(["Write spec", "Code review"]);

    await expect(withAuthorizedTenant(ctx, (tx) => addChecklistItem(tx, { issueId, text: "   ", createdBy: userId }))).rejects.toThrow(/required/);
  });

  it("summarises progress per issue and surfaces it on board cards", async () => {
    const { issueId, boardId } = await seedIssue();
    const a = await withAuthorizedTenant(ctx, (tx) => addChecklistItem(tx, { issueId, text: "One", createdBy: userId }));
    await withAuthorizedTenant(ctx, (tx) => addChecklistItem(tx, { issueId, text: "Two", createdBy: userId }));
    await withAuthorizedTenant(ctx, (tx) => updateChecklistItem(tx, { itemId: a.id, done: true }));

    const summaries = await withAuthorizedTenant(ctx, (tx) => getChecklistSummaries(tx, [issueId, "missing-issue"]));
    expect(summaries.get(issueId)).toEqual({ done: 1, total: 2 });
    expect(summaries.has("missing-issue")).toBe(false);

    const board = await withAuthorizedTenant(ctx, (tx) => getBoard(tx, boardId));
    const card = board.columns.flatMap((col) => col.issues).find((i) => i.id === issueId);
    expect(card?.checklist).toEqual({ done: 1, total: 2 });
  });

  it("is invisible to, and not writable by, a workspace member outside the project's team", async () => {
    const { issueId } = await seedIssue();
    const item = await withAuthorizedTenant(ctx, (tx) => addChecklistItem(tx, { issueId, text: "Secret", createdBy: userId }));
    const outsider = { userId: outsiderId, organizationId: orgId };

    expect(await withAuthorizedTenant(outsider, (tx) => listChecklistItems(tx, issueId))).toEqual([]);
    await expect(withAuthorizedTenant(outsider, (tx) => addChecklistItem(tx, { issueId, text: "Nope", createdBy: outsiderId }))).rejects.toThrow(/not found/);
    await expect(withAuthorizedTenant(outsider, (tx) => updateChecklistItem(tx, { itemId: item.id, done: true }))).rejects.toThrow(/not found/);
  });
});
