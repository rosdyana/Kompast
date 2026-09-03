import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { addComment, listComments } from "../comment";
import { setWatching, listWatchers } from "../watcher";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("comments + watchers", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-cw-org";
  const userId = "test-cw-user";

  beforeEach(async () => {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));

    await admin.insert(schema.organization).values({ id: orgId, name: "Test CW Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Test User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await adminClient.end();
  });

  async function seedIssue() {
    return withAuthorizedTenant({ userId, organizationId: orgId }, async (tx) => {
      const { projectId, issueTypes, statuses } = await createProject(tx, {
        organizationId: orgId,
        key: "cw",
        name: "CW",
        actorUserId: userId,
      });
      const { issueId } = await createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: issueTypes[0]!.id,
        statusId: statuses[0]!.id,
        title: "Test issue",
        reporterId: userId,
      });
      return issueId;
    });
  }

  it("adds and lists comments in order", async () => {
    const issueId = await seedIssue();

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      addComment(tx, { issueId, authorId: userId, bodyJson: { text: "first" } }),
    );
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      addComment(tx, { issueId, authorId: userId, bodyJson: { text: "second" } }),
    );

    const comments = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listComments(tx, issueId));
    expect(comments.map((c) => (c.bodyJson as { text: string }).text)).toEqual(["first", "second"]);
  });

  it("toggles watching idempotently", async () => {
    const issueId = await seedIssue();

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      setWatching(tx, { issueId, userId, watching: true }),
    );
    // Calling it again while already watching must not error or duplicate.
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      setWatching(tx, { issueId, userId, watching: true }),
    );

    let watchers = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listWatchers(tx, issueId));
    expect(watchers).toHaveLength(1);

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      setWatching(tx, { issueId, userId, watching: false }),
    );
    watchers = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listWatchers(tx, issueId));
    expect(watchers).toHaveLength(0);
  });
});
