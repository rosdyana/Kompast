import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import {
  createIssuePropertyDefinition,
  deleteIssuePropertyDefinition,
  listIssuePropertyDefinitions,
  updateIssuePropertyDefinition,
} from "../issue-property";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("issue property definitions", () => {
  const env = loadEnv();
  const admin = drizzle(postgres(env.DATABASE_ADMIN_URL, { max: 1 }));

  const orgId = "test-iprop-org";
  const userId = "test-iprop-user";
  const teamId = "test-iprop-team";

  async function cleanup() {
    // issue_property_definition.project_id cascades on project delete — no manual cleanup needed for it.
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  async function resetFixtures() {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Test Issue Property Org", slug: orgId });
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

  it("creates a definition, slugifying the name into a key", async () => {
    const { projectId } = await seedProject("IPA");
    const { key } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssuePropertyDefinition(tx, { projectId, name: "Story Points v2", type: "number" }),
    );
    expect(key).toBe("story_points_v2");

    const defs = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listIssuePropertyDefinitions(tx, projectId));
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe("Story Points v2");
    expect(defs[0]?.isCore).toBe(false);
  });

  it("disambiguates a colliding key with a numeric suffix instead of throwing", async () => {
    const { projectId } = await seedProject("IPB");
    const a = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => createIssuePropertyDefinition(tx, { projectId, name: "Budget", type: "number" }));
    const b = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => createIssuePropertyDefinition(tx, { projectId, name: "Budget", type: "number" }));
    expect(a.key).toBe("budget");
    expect(b.key).toBe("budget_2");
  });

  it("rejects the reserved 'jira' key by disambiguating around it", async () => {
    const { projectId } = await seedProject("IPC");
    const { key } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssuePropertyDefinition(tx, { projectId, name: "Jira", type: "text" }),
    );
    expect(key).not.toBe("jira");
    expect(key).toBe("jira_2");
  });

  it("requires options for select/multiSelect types", async () => {
    const { projectId } = await seedProject("IPD");
    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => createIssuePropertyDefinition(tx, { projectId, name: "Status", type: "select" })),
    ).rejects.toThrow();

    const { definitionId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssuePropertyDefinition(tx, {
        projectId,
        name: "Status",
        type: "select",
        options: [{ value: "a", label: "A" }],
      }),
    );
    expect(definitionId).toBeTruthy();
  });

  it("updateIssuePropertyDefinition never changes key even when name changes", async () => {
    const { projectId } = await seedProject("IPE");
    const { definitionId, key } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssuePropertyDefinition(tx, { projectId, name: "Original Name", type: "text" }),
    );
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      updateIssuePropertyDefinition(tx, { projectId, definitionId, name: "Renamed", visibleOnCard: true }),
    );
    const [row] = await admin.select().from(schema.issuePropertyDefinition).where(eq(schema.issuePropertyDefinition.id, definitionId));
    expect(row?.name).toBe("Renamed");
    expect(row?.key).toBe(key); // unchanged
    expect(row?.visibleOnCard).toBe(true);
  });

  it("deleteIssuePropertyDefinition refuses to delete a core property", async () => {
    const { projectId } = await seedProject("IPF");
    const { definitionId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssuePropertyDefinition(tx, { projectId, name: "Core Field", type: "text" }),
    );
    await admin.update(schema.issuePropertyDefinition).set({ isCore: true }).where(eq(schema.issuePropertyDefinition.id, definitionId));

    await expect(
      withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deleteIssuePropertyDefinition(tx, { projectId, definitionId })),
    ).rejects.toThrow("Core");

    await admin.update(schema.issuePropertyDefinition).set({ isCore: false }).where(eq(schema.issuePropertyDefinition.id, definitionId));
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => deleteIssuePropertyDefinition(tx, { projectId, definitionId }));
    const defs = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listIssuePropertyDefinitions(tx, projectId));
    expect(defs).toHaveLength(0);
  });
});
