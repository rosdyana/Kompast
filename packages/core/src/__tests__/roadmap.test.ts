import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue, updateIssue } from "../issue";
import { getEpicRoadmap } from "../roadmap";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("epic roadmap", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-roadmap-org";
  const userId = "test-roadmap-user";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Roadmap Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  const ctx = { userId, organizationId: orgId };

  it("returns each epic with its child completion, and epicId is settable via updateIssue", async () => {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, key: "rdm", name: "Roadmap Test", actorUserId: userId }),
    );
    const epicType = issueTypes.find((t) => t.name === "Epic")!;
    const storyType = issueTypes.find((t) => t.name === "Story")!;

    const epicId = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: epicType.id,
        statusId: statuses[0]!.id,
        title: "Big epic",
        reporterId: userId,
        dueDate: new Date("2026-12-31"),
      }).then((r) => r.issueId),
    );

    const child1 = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: storyType.id, statusId: statuses[4]!.id, title: "Child done", reporterId: userId }).then((r) => r.issueId),
    );
    const child2 = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: storyType.id, statusId: statuses[0]!.id, title: "Child not done", reporterId: userId }).then((r) => r.issueId),
    );
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, child1, { epicId, actorId: userId }));
    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, child2, { epicId, actorId: userId }));

    const roadmap = await withAuthorizedTenant(ctx, (tx) => getEpicRoadmap(tx, projectId));
    expect(roadmap).toHaveLength(1);
    expect(roadmap[0]).toMatchObject({ id: epicId, title: "Big epic", childCount: 2, doneCount: 1 });
    expect(roadmap[0]!.dueDate).toBeTruthy();
  });

  it("returns an empty list for a project with no epics populated", async () => {
    const { projectId } = await withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, key: "emp", name: "Empty Roadmap", actorUserId: userId }));
    const roadmap = await withAuthorizedTenant(ctx, (tx) => getEpicRoadmap(tx, projectId));
    expect(roadmap).toEqual([]);
  });
});
