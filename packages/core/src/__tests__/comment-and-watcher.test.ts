import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
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
  const assigneeId = "test-cw-assignee";

  async function cleanup() {
    await admin.delete(schema.notification).where(eq(schema.notification.organizationId, orgId));
    await admin.delete(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, assigneeId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Test CW Org", slug: orgId });
    await admin.insert(schema.user).values([
      { id: userId, name: "Test User", email: `${userId}@example.com` },
      { id: assigneeId, name: "Assignee", email: `${assigneeId}@example.com` },
    ]);
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: assigneeId, role: "member" },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  async function seedIssue(overrides: Partial<Parameters<typeof createIssue>[1]> = {}) {
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
        ...overrides,
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

  it("addComment notifies the issue's assignee, but not the commenter about their own comment", async () => {
    const issueId = await seedIssue({ assigneeId }); // create-time assignment already queues one notification

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => addComment(tx, { issueId, authorId: userId, bodyJson: { text: "hello" } }));

    const notifications = await admin.select().from(schema.notification).where(eq(schema.notification.organizationId, orgId));
    const commentNotifications = notifications.filter((n) => n.eventType === "issue.commented");
    expect(commentNotifications).toHaveLength(1);
    expect(commentNotifications[0]).toMatchObject({ userId: assigneeId, entityId: issueId });

    // The reporter (userId) is also the commenter here, so they must not be notified about their own comment.
    expect(notifications.some((n) => n.userId === userId && n.eventType === "issue.commented")).toBe(false);
  });

  it("addComment does not notify anyone when the commenter is the only participant", async () => {
    const issueId = await seedIssue(); // reporter === userId, no assignee

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => addComment(tx, { issueId, authorId: userId, bodyJson: { text: "solo" } }));

    const notifications = await admin.select().from(schema.notification).where(eq(schema.notification.organizationId, orgId));
    expect(notifications.filter((n) => n.eventType === "issue.commented")).toHaveLength(0);
  });

  it('addComment with origin:"import" never notifies, even with an assignee who would otherwise be notified, and honors a backdated createdAt', async () => {
    const issueId = await seedIssue({ assigneeId }); // create-time assignment already queues one notification
    const backdated = new Date("2018-03-01T00:00:00.000Z");

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      addComment(tx, { issueId, authorId: userId, bodyJson: { text: "old jira comment" }, origin: "import", createdAt: backdated }),
    );

    const notifications = await admin.select().from(schema.notification).where(eq(schema.notification.organizationId, orgId));
    // Exactly the one notification from seedIssue's create-time assignment — none from the import comment.
    expect(notifications.filter((n) => n.eventType === "issue.commented")).toHaveLength(0);

    const [comment] = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listComments(tx, issueId));
    expect(comment?.createdAt).toEqual(backdated);
  });
});
