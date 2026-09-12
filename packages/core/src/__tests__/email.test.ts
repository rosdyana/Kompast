import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, inArray, adminDb as admin } from "@kompast/db";
import { enqueueEmail, claimPendingEmails, markEmailSent, markEmailFailed, sendSprintSummaryEmail } from "../email";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("email outbox", () => {
  const orgId = "test-email-org";
  const userId = "test-email-user";

  async function cleanup() {
    await admin.delete(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Email Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
  });

  const ctx = { userId, organizationId: orgId };

  it("enqueueEmail dedupes a repeated dedupeKey instead of creating a second row", async () => {
    const first = await withAuthorizedTenant(ctx, (tx) =>
      enqueueEmail(tx, { organizationId: orgId, to: "a@example.com", subject: "Hi", templateKey: "test", templateProps: {}, dedupeKey: "dk-1" }),
    );
    expect(first.deduped).toBe(false);

    const second = await withAuthorizedTenant(ctx, (tx) =>
      enqueueEmail(tx, { organizationId: orgId, to: "a@example.com", subject: "Hi again", templateKey: "test", templateProps: {}, dedupeKey: "dk-1" }),
    );
    expect(second.deduped).toBe(true);
    expect(second.outboxId).toBe(first.outboxId);

    const rows = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
  });

  it("claimPendingEmails claims pending rows across the whole table (admin, not tenant-scoped) and marks them sending", async () => {
    await withAuthorizedTenant(ctx, (tx) =>
      enqueueEmail(tx, { organizationId: orgId, to: "a@example.com", subject: "Hi", templateKey: "test", templateProps: {}, dedupeKey: "dk-claim" }),
    );

    // Deliberately unscoped by design (see email.ts) — a real worker process
    // claims across every workspace. That means it can also claim rows from
    // OTHER test files' fixtures if they happen to be pending at the same
    // moment (vitest runs files in parallel); restore anything not ours so
    // this test doesn't corrupt a concurrently-running file's expectations.
    const claimed = await claimPendingEmails(admin, 10);
    const ours = claimed.filter((r) => r.organizationId === orgId);
    const theirs = claimed.filter((r) => r.organizationId !== orgId);
    if (theirs.length > 0) {
      await admin.update(schema.emailOutbox).set({ status: "pending" }).where(inArray(schema.emailOutbox.id, theirs.map((r) => r.id)));
    }
    expect(ours).toHaveLength(1);
    expect(ours[0]!.status).toBe("sending");

    const notClaimedAgain = await claimPendingEmails(admin, 10);
    expect(notClaimedAgain.filter((r) => r.organizationId === orgId)).toHaveLength(0);
    const theirsAgain = notClaimedAgain.filter((r) => r.organizationId !== orgId);
    if (theirsAgain.length > 0) {
      await admin.update(schema.emailOutbox).set({ status: "pending" }).where(inArray(schema.emailOutbox.id, theirsAgain.map((r) => r.id)));
    }
  });

  it("markEmailSent and markEmailFailed update status and the relevant field", async () => {
    const { outboxId: sentId } = await withAuthorizedTenant(ctx, (tx) =>
      enqueueEmail(tx, { organizationId: orgId, to: "a@example.com", subject: "Sent", templateKey: "test", templateProps: {}, dedupeKey: "dk-sent" }),
    );
    const { outboxId: failedId } = await withAuthorizedTenant(ctx, (tx) =>
      enqueueEmail(tx, { organizationId: orgId, to: "a@example.com", subject: "Failed", templateKey: "test", templateProps: {}, dedupeKey: "dk-failed" }),
    );

    await markEmailSent(admin, sentId, "provider-msg-123");
    await markEmailFailed(admin, failedId, "SMTP timeout");

    const [sentRow] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, sentId));
    expect(sentRow?.status).toBe("sent");
    expect(sentRow?.providerMessageId).toBe("provider-msg-123");
    expect(sentRow?.sentAt).toBeTruthy();

    const [failedRow] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, failedId));
    expect(failedRow?.status).toBe("failed");
    expect(failedRow?.error).toBe("SMTP timeout");
  });

  it("sendSprintSummaryEmail enqueues one outbox row per recipient with the sprint-summary template", async () => {
    const result = await withAuthorizedTenant(ctx, (tx) =>
      sendSprintSummaryEmail(tx, { organizationId: orgId, sprintId: "test-sprint-1", recipients: ["a@example.com", "b@example.com"], subject: "Sprint 1 Summary", body: "Line one\nLine two" }),
    );
    expect(result).toEqual({ sent: 2, deduped: 0 });

    const rows = await admin
      .select()
      .from(schema.emailOutbox)
      .where(and(eq(schema.emailOutbox.organizationId, orgId), eq(schema.emailOutbox.templateKey, "sprint-summary")));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.toEmail).sort()).toEqual(["a@example.com", "b@example.com"]);
    for (const row of rows) {
      expect(row.subject).toBe("Sprint 1 Summary");
      expect(row.templateProps).toEqual({ subject: "Sprint 1 Summary", body: "Line one\nLine two" });
    }
  });

  it("a later, separate sendSprintSummaryEmail call for the same sprint+recipient is not deduped away by an earlier send", async () => {
    await withAuthorizedTenant(ctx, (tx) =>
      sendSprintSummaryEmail(tx, { organizationId: orgId, sprintId: "test-sprint-2", recipients: ["a@example.com"], subject: "First send", body: "v1" }),
    );
    const second = await withAuthorizedTenant(ctx, (tx) =>
      sendSprintSummaryEmail(tx, { organizationId: orgId, sprintId: "test-sprint-2", recipients: ["a@example.com"], subject: "Second send", body: "v2" }),
    );
    expect(second).toEqual({ sent: 1, deduped: 0 });

    const rows = await admin
      .select()
      .from(schema.emailOutbox)
      .where(and(eq(schema.emailOutbox.organizationId, orgId), eq(schema.emailOutbox.templateKey, "sprint-summary")));
    expect(rows).toHaveLength(2);
  });

  it("rejects an empty recipient list", async () => {
    await expect(
      withAuthorizedTenant(ctx, (tx) => sendSprintSummaryEmail(tx, { organizationId: orgId, sprintId: "test-sprint-3", recipients: [], subject: "Empty", body: "" })),
    ).rejects.toThrow(/recipient/i);
  });
});
