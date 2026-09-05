import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { linkIssues, listIssueLinks } from "../issue-link";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("issue links", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-ilink-org";
  const userId = "test-ilink-user";
  const ctx = { userId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Test Issue Link Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  async function seedTwoIssues() {
    return withAuthorizedTenant(ctx, async (tx) => {
      const { projectId, issueTypes, statuses } = await createProject(tx, { organizationId: orgId, key: "ilnk", name: "Issue Link Test", actorUserId: userId });
      const a = await createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Issue A", reporterId: userId });
      const b = await createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Issue B", reporterId: userId });
      return { issueAId: a.issueId, issueBId: b.issueId };
    });
  }

  it("links two issues directionally and finds the link from either side", async () => {
    const { issueAId, issueBId } = await seedTwoIssues();

    await withAuthorizedTenant(ctx, (tx) => linkIssues(tx, { fromIssueId: issueAId, toIssueId: issueBId, type: "blocks" }));

    const fromA = await withAuthorizedTenant(ctx, (tx) => listIssueLinks(tx, issueAId));
    expect(fromA).toHaveLength(1);
    expect(fromA[0]).toMatchObject({ fromIssueId: issueAId, toIssueId: issueBId, type: "blocks" });

    const fromB = await withAuthorizedTenant(ctx, (tx) => listIssueLinks(tx, issueBId));
    expect(fromB).toHaveLength(1);
    expect(fromB[0]?.fromIssueId).toBe(issueAId);
  });

  it("supports multiple link types between the same pair without conflict", async () => {
    const { issueAId, issueBId } = await seedTwoIssues();

    await withAuthorizedTenant(ctx, (tx) => linkIssues(tx, { fromIssueId: issueAId, toIssueId: issueBId, type: "relates" }));
    await withAuthorizedTenant(ctx, (tx) => linkIssues(tx, { fromIssueId: issueBId, toIssueId: issueAId, type: "duplicates" }));

    const links = await withAuthorizedTenant(ctx, (tx) => listIssueLinks(tx, issueAId));
    expect(links.map((l) => l.type).sort()).toEqual(["duplicates", "relates"]);
  });
});
