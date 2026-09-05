import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { logWork, listWorklogs } from "../worklog";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("worklog", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-worklog-org";
  const userId = "test-worklog-user";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Test Worklog Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Test User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  async function seedIssue() {
    return withAuthorizedTenant({ userId, organizationId: orgId }, async (tx) => {
      const { projectId, issueTypes, statuses } = await createProject(tx, { organizationId: orgId, key: "wlog", name: "Worklog Test", actorUserId: userId });
      const { issueId } = await createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Test issue", reporterId: userId });
      return issueId;
    });
  }

  it("logs work and accumulates issue.spentSeconds across multiple entries", async () => {
    const issueId = await seedIssue();
    const ctx = { userId, organizationId: orgId };

    await withAuthorizedTenant(ctx, (tx) => logWork(tx, { issueId, userId, seconds: 3600, note: "first session" }));
    await withAuthorizedTenant(ctx, (tx) => logWork(tx, { issueId, userId, seconds: 1800 }));

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.spentSeconds).toBe(5400);

    const entries = await withAuthorizedTenant(ctx, (tx) => listWorklogs(tx, issueId));
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.seconds)).toEqual([3600, 1800]);
    expect(entries[0]?.note).toBe("first session");
  });

  it("preserves a backdated loggedAt (for importers reconstructing JIRA worklog history)", async () => {
    const issueId = await seedIssue();
    const ctx = { userId, organizationId: orgId };
    const backdated = new Date("2019-06-01T00:00:00.000Z");

    await withAuthorizedTenant(ctx, (tx) => logWork(tx, { issueId, userId, seconds: 900, loggedAt: backdated }));

    const [entry] = await withAuthorizedTenant(ctx, (tx) => listWorklogs(tx, issueId));
    expect(entry?.loggedAt).toEqual(backdated);
  });

  it("lists worklogs ordered by loggedAt, oldest first, regardless of insertion order", async () => {
    const issueId = await seedIssue();
    const ctx = { userId, organizationId: orgId };
    const earlier = new Date("2020-01-01T00:00:00.000Z");
    const later = new Date("2020-06-01T00:00:00.000Z");

    await withAuthorizedTenant(ctx, (tx) => logWork(tx, { issueId, userId, seconds: 100, loggedAt: later }));
    await withAuthorizedTenant(ctx, (tx) => logWork(tx, { issueId, userId, seconds: 200, loggedAt: earlier }));

    const entries = await withAuthorizedTenant(ctx, (tx) => listWorklogs(tx, issueId));
    expect(entries.map((e) => e.seconds)).toEqual([200, 100]);
  });
});
