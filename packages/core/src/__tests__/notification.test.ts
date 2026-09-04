import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  notify,
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getNotificationPref,
  setNotificationPref,
} from "../notification";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("notifications", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-notification-org";
  const userId = "test-notification-user";

  async function cleanup() {
    await admin.delete(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    await admin.delete(schema.notification).where(eq(schema.notification.organizationId, orgId));
    await admin.delete(schema.notificationPref).where(eq(schema.notificationPref.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Notification Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  const ctx = { userId, organizationId: orgId };

  it("defaults to in-app + instant email when no preference row exists", async () => {
    const pref = await withAuthorizedTenant(ctx, (tx) => getNotificationPref(tx, orgId, userId, "issue.assigned"));
    expect(pref).toEqual({ inApp: true, email: true, digest: "instant" });
  });

  it("notify() writes an in-app notification and queues an email by default", async () => {
    const result = await withAuthorizedTenant(ctx, (tx) =>
      notify(tx, {
        organizationId: orgId,
        userId,
        eventType: "issue.assigned",
        entityType: "issue",
        entityId: "issue_fake",
        title: "You were assigned KPT-1",
        email: { to: `${userId}@example.com`, actionUrl: "https://kompast.example/issues/KPT-1", actionLabel: "View issue" },
      }),
    );
    expect(result.notificationId).toBeTruthy();
    expect(result.emailQueued).toBe(true);

    const notifications = await withAuthorizedTenant(ctx, (tx) => listNotifications(tx, orgId, userId));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe("You were assigned KPT-1");

    // Not asserting `status` here: email.test.ts exercises the real
    // system-wide (unscoped-by-org) claimPendingEmails against this same
    // real table, and since vitest runs test files in parallel, this row
    // could legitimately get claimed between notify() committing and this
    // read — that's correct concurrent behavior, not something notify()
    // promises against. The immutable fields it does promise are covered
    // below; the "starts out pending" guarantee is covered in
    // email.test.ts's own enqueueEmail test, which never calls
    // claimPendingEmails so has nothing to race with.
    const [outboxRow] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    expect(outboxRow?.toEmail).toBe(`${userId}@example.com`);
    expect(outboxRow?.templateKey).toBe("notification");
  });

  it("respects a preference turning email off — no outbox row, in-app notification still written", async () => {
    await withAuthorizedTenant(ctx, (tx) => setNotificationPref(tx, { organizationId: orgId, userId, eventType: "issue.commented", email: false }));

    const result = await withAuthorizedTenant(ctx, (tx) =>
      notify(tx, {
        organizationId: orgId,
        userId,
        eventType: "issue.commented",
        entityType: "issue",
        entityId: "issue_fake",
        title: "New comment",
        email: { to: `${userId}@example.com`, actionUrl: "https://kompast.example/issues/KPT-1", actionLabel: "View issue" },
      }),
    );
    expect(result.notificationId).toBeTruthy();
    expect(result.emailQueued).toBe(false);

    const outboxRows = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    expect(outboxRows).toHaveLength(0);
  });

  it("a digest preference other than instant suppresses the email even when email is on", async () => {
    await withAuthorizedTenant(ctx, (tx) => setNotificationPref(tx, { organizationId: orgId, userId, eventType: "issue.commented", email: true, digest: "daily" }));

    const result = await withAuthorizedTenant(ctx, (tx) =>
      notify(tx, {
        organizationId: orgId,
        userId,
        eventType: "issue.commented",
        entityType: "issue",
        entityId: "issue_fake",
        title: "New comment",
        email: { to: `${userId}@example.com`, actionUrl: "https://kompast.example/issues/KPT-1", actionLabel: "View issue" },
      }),
    );
    expect(result.emailQueued).toBe(false);
  });

  it("marks a single notification read, and marks all read", async () => {
    await withAuthorizedTenant(ctx, (tx) =>
      notify(tx, { organizationId: orgId, userId, eventType: "issue.assigned", entityType: "issue", entityId: "i1", title: "First" }),
    );
    const second = await withAuthorizedTenant(ctx, (tx) =>
      notify(tx, { organizationId: orgId, userId, eventType: "issue.assigned", entityType: "issue", entityId: "i2", title: "Second" }),
    );

    expect(await withAuthorizedTenant(ctx, (tx) => countUnreadNotifications(tx, orgId, userId))).toBe(2);

    await withAuthorizedTenant(ctx, (tx) => markNotificationRead(tx, second.notificationId!, userId));
    expect(await withAuthorizedTenant(ctx, (tx) => countUnreadNotifications(tx, orgId, userId))).toBe(1);

    await withAuthorizedTenant(ctx, (tx) => markAllNotificationsRead(tx, orgId, userId));
    expect(await withAuthorizedTenant(ctx, (tx) => countUnreadNotifications(tx, orgId, userId))).toBe(0);
  });
});
