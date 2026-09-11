import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue } from "../issue";
import {
  createPriorityLevel,
  deletePriorityLevel,
  listPriorityLevels,
  updatePriorityLevel,
} from "../priority";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("priority levels", () => {
  const env = loadEnv();
  const admin = drizzle(postgres(env.DATABASE_ADMIN_URL, { max: 1 }));

  const orgId = "test-prio-org";
  const userId = "test-prio-user";
  const teamId = "test-prio-team";

  async function cleanup() {
    // priority_level.project_id cascades on project delete — no manual cleanup needed for it.
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  async function resetFixtures() {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Test Priority Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "owner", isSuperAdmin: true });
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Test Team" });
  }

  beforeEach(resetFixtures);
  afterAll(cleanup);

  async function seedProject(key: string) {
    const result = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId }),
    );
    const [project] = await admin.select().from(schema.project).where(eq(schema.project.key, key));
    return { ...result, projectId: project!.id };
  }

  it("createProject seeds the five default priority levels in order", async () => {
    const { projectId, priorityLevels } = await seedProject("PSA");
    expect(priorityLevels).toHaveLength(5);
    expect(priorityLevels.map((p) => p.key)).toEqual(["very_low", "low", "medium", "high", "critical"]);

    const levels = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listPriorityLevels(tx, projectId));
    expect(levels).toHaveLength(5);
    expect(levels.map((l) => l.key)).toEqual(["very_low", "low", "medium", "high", "critical"]);
  });

  it("creates a level, slugifying the name into a key", async () => {
    const { projectId } = await seedProject("PRA");
    const { key } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createPriorityLevel(tx, { projectId, name: "Super Urgent!!", color: "var(--danger)" }),
    );
    expect(key).toBe("super_urgent");

    const levels = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listPriorityLevels(tx, projectId));
    // 5 seeded defaults + 1 new one.
    expect(levels).toHaveLength(6);
    expect(levels.at(-1)?.name).toBe("Super Urgent!!");
  });

  it("disambiguates a colliding key with a numeric suffix instead of throwing", async () => {
    const { projectId } = await seedProject("PRB");
    const a = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => createPriorityLevel(tx, { projectId, name: "Urgent", color: "var(--danger)" }));
    const b = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => createPriorityLevel(tx, { projectId, name: "Urgent", color: "var(--danger)" }));
    expect(a.key).toBe("urgent");
    expect(b.key).toBe("urgent_2");
  });

  it("updatePriorityLevel never changes key even when name changes", async () => {
    const { projectId } = await seedProject("PRC");
    const { levelId, key } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createPriorityLevel(tx, { projectId, name: "Original Name", color: "var(--indigo)" }),
    );
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      updatePriorityLevel(tx, { projectId, levelId, name: "Renamed", color: "var(--amber)" }),
    );
    const [row] = await admin.select().from(schema.priorityLevel).where(eq(schema.priorityLevel.id, levelId));
    expect(row?.name).toBe("Renamed");
    expect(row?.color).toBe("var(--amber)");
    expect(row?.key).toBe(key); // unchanged
  });

  it("updatePriorityLevel throws for a level that doesn't exist in the project", async () => {
    const { projectId } = await seedProject("PRD");
    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
        updatePriorityLevel(tx, { projectId, levelId: "nonexistent", name: "X" }),
      ),
    ).rejects.toThrow();
  });

  it("deletePriorityLevel throws when the level is in use by an issue", async () => {
    const { projectId, issueTypes, statuses, priorityLevels } = await seedProject("PRE");
    const taskType = issueTypes.find((t) => t.name === "Task")!;
    const todoStatus = statuses.find((s) => s.name === "To Do")!;
    const highLevel = priorityLevels.find((p) => p.key === "high")!;

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: taskType.id,
        statusId: todoStatus.id,
        title: "Uses high priority",
        reporterId: userId,
        priority: highLevel.key,
      }),
    );

    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deletePriorityLevel(tx, { projectId, levelId: highLevel.id })),
    ).rejects.toThrow("still in use");
  });

  it("deletePriorityLevel throws when it's the last remaining level", async () => {
    const { projectId, priorityLevels } = await seedProject("PRF");

    // Delete the four unused, non-last levels first so exactly one remains.
    for (const level of priorityLevels.slice(0, 4)) {
      await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deletePriorityLevel(tx, { projectId, levelId: level.id }));
    }

    const last = priorityLevels[4]!;
    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deletePriorityLevel(tx, { projectId, levelId: last.id })),
    ).rejects.toThrow("last remaining");
  });

  it("deletePriorityLevel succeeds for an unused, non-last level", async () => {
    const { projectId, priorityLevels } = await seedProject("PRG");
    const veryLow = priorityLevels.find((p) => p.key === "very_low")!;

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deletePriorityLevel(tx, { projectId, levelId: veryLow.id }));

    const remaining = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listPriorityLevels(tx, projectId));
    expect(remaining).toHaveLength(4);
    expect(remaining.find((l) => l.id === veryLow.id)).toBeUndefined();
  });

  it("deletePriorityLevel throws for a level that doesn't exist in the project", async () => {
    const { projectId } = await seedProject("PRH");
    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deletePriorityLevel(tx, { projectId, levelId: "nonexistent" })),
    ).rejects.toThrow("not found");
  });
});
