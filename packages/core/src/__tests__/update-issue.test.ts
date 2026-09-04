import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue, updateIssue } from "../issue";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("updateIssue + createIssue attribution", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-updateissue-org";
  const userId = "test-updateissue-user";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Update Issue Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  async function seedIssue(ctx: { userId: string; organizationId: string }, overrides: Partial<Parameters<typeof createIssue>[1]> = {}) {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, key: "upd", name: "Update Test", actorUserId: ctx.userId }),
    );
    const result = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: issueTypes[0]!.id,
        statusId: statuses[0]!.id,
        title: "Original title",
        reporterId: ctx.userId,
        ...overrides,
      }),
    );
    return { projectId, issueId: result.issueId };
  }

  it("createIssue records origin/originClient on the issue and its creation history row", async () => {
    const ctx = { userId, organizationId: orgId };
    const { issueId } = await seedIssue(ctx, { origin: "mcp", originClient: "claude-code" });

    const [issue] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(issue?.origin).toBe("mcp");
    expect(issue?.originClient).toBe("claude-code");

    const [history] = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issueId));
    expect(history?.origin).toBe("mcp");
    expect(history?.originClient).toBe("claude-code");
  });

  it("updateIssue changes only the given fields and writes one history row per changed field", async () => {
    const ctx = { userId, organizationId: orgId };
    const { issueId } = await seedIssue(ctx);

    await withAuthorizedTenant(ctx, (tx) =>
      updateIssue(tx, issueId, { title: "New title", priority: "highest", actorId: userId, origin: "api", originClient: "cli-tool" }),
    );

    const [updated] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(updated?.title).toBe("New title");
    expect(updated?.priority).toBe("highest");

    const history = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issueId));
    const nonCreation = history.filter((h) => h.field !== "created");
    expect(nonCreation).toHaveLength(2);
    expect(nonCreation.every((h) => h.origin === "api" && h.originClient === "cli-tool")).toBe(true);
    expect(nonCreation.find((h) => h.field === "title")).toMatchObject({ fromValue: "Original title", toValue: "New title" });
    expect(nonCreation.find((h) => h.field === "priority")).toMatchObject({ fromValue: "medium", toValue: "highest" });
  });

  it("updateIssue does not write a history row for a field that didn't actually change", async () => {
    const ctx = { userId, organizationId: orgId };
    const { issueId } = await seedIssue(ctx);

    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, issueId, { title: "Original title", actorId: userId }));

    const history = await admin.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issueId));
    expect(history.filter((h) => h.field !== "created")).toHaveLength(0);
  });

  it("updateIssue can clear an assignee by passing null", async () => {
    const ctx = { userId, organizationId: orgId };
    const { issueId } = await seedIssue(ctx, { assigneeId: userId });

    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, issueId, { assigneeId: null, actorId: userId }));

    const [updated] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(updated?.assigneeId).toBeNull();
  });

  it("updateIssue replaces labels wholesale without a diffable history row", async () => {
    const ctx = { userId, organizationId: orgId };
    const { issueId } = await seedIssue(ctx, { labels: ["a", "b"] });

    await withAuthorizedTenant(ctx, (tx) => updateIssue(tx, issueId, { labels: ["c"], actorId: userId }));

    const [updated] = await admin.select().from(schema.issue).where(eq(schema.issue.id, issueId));
    expect(updated?.labels).toEqual(["c"]);
  });
});
