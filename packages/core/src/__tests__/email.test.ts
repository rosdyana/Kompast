import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and, inArray, sql, adminDb as admin } from "@kompast/db";
import { enqueueEmail, claimPendingEmails, markEmailSent, markEmailFailed, sendSprintSummaryEmail, recordEmailFailure, MAX_EMAIL_ATTEMPTS } from "../email";
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

  /**
   * Inserts one outbox row for orgId with the admin connection, so a test controls status, attempts and
   * claimedAt exactly. Timestamps are given as SQL (now() - interval ...), so they are computed by the database,
   * the same clock the claim query uses.
   */
  async function insertOutboxRow(fields: Partial<Omit<typeof schema.emailOutbox.$inferInsert, "claimedAt">> & { claimedAt?: Date | ReturnType<typeof sql> | null } = {}) {
    const rowId = id("outbox");
    await admin.insert(schema.emailOutbox).values({
      id: rowId,
      organizationId: orgId,
      toEmail: "a@example.com",
      subject: "s",
      templateKey: "test",
      templateProps: {},
      dedupeKey: id("dk"),
      ...fields,
    } as typeof schema.emailOutbox.$inferInsert);
    return rowId;
  }

  /**
   * Claims in batches of 500 and returns the ids of OUR rows that came back. Other workspaces' rows in a batch
   * are restored to "pending" (as in the claim test above). A restored row is claimable again at once, so this
   * stops when a batch holds none of other workspaces' rows, or after a fixed number of batches: waiting for an
   * empty batch could never finish while another file has a pending row.
   */
  async function claimAndCollectOurs(): Promise<string[]> {
    const ours: string[] = [];
    for (let i = 0; i < 20; i++) {
      const claimed = await claimPendingEmails(admin, 500);
      if (claimed.length === 0) break;
      ours.push(...claimed.filter((r) => r.organizationId === orgId).map((r) => r.id));
      const theirs = claimed.filter((r) => r.organizationId !== orgId);
      if (theirs.length === 0) break;
      await admin.update(schema.emailOutbox).set({ status: "pending" }).where(inArray(schema.emailOutbox.id, theirs.map((r) => r.id)));
    }
    return ours;
  }

  /** Whether the row's claimed_at is within the last minute, judged by the database clock. */
  async function claimedWithinMinute(rowId: string): Promise<boolean> {
    const rows = await admin.execute<{ recent: boolean }>(
      sql`select claimed_at > now() - interval '1 minute' as recent from email_outbox where id = ${rowId}`,
    );
    return rows[0]?.recent === true;
  }

  it("reclaims a row left 'sending' by a dead worker once the claim is stale", async () => {
    const rowId = await insertOutboxRow({ status: "sending", claimedAt: sql`now() - interval '2 hours'` });

    const ours = await claimAndCollectOurs();

    expect(ours).toContain(rowId);
    const [row] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, rowId));
    expect(row?.status).toBe("sending");
    expect(await claimedWithinMinute(rowId)).toBe(true);
  });

  it("does not reclaim a fresh 'sending' row, or one stuck from before claimed_at existed", async () => {
    const freshId = await insertOutboxRow({ status: "sending", claimedAt: sql`now()` });
    const legacyId = await insertOutboxRow({ status: "sending", claimedAt: null });

    const ours = await claimAndCollectOurs();

    expect(ours).not.toContain(freshId);
    expect(ours).not.toContain(legacyId);
    const [legacy] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, legacyId));
    expect(legacy?.status).toBe("sending");
    expect(legacy?.claimedAt).toBeNull();
  });

  it("recordEmailFailure retries with backoff, then fails for good", async () => {
    const { outboxId } = await withAuthorizedTenant(ctx, (tx) =>
      enqueueEmail(tx, { organizationId: orgId, to: "a@example.com", subject: "Retry", templateKey: "test", templateProps: {}, dedupeKey: "dk-retry" }),
    );

    expect(await recordEmailFailure(admin, outboxId, "boom")).toBe("pending");
    const [afterFirst] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, outboxId));
    expect(afterFirst).toMatchObject({ attempts: 1, error: "boom", status: "pending" });

    // The failed attempt was just now, so the 2-minute backoff has not passed.
    expect(await claimAndCollectOurs()).not.toContain(outboxId);

    // Two hours on, the backoff has passed and the row is claimed again.
    await admin.update(schema.emailOutbox).set({ claimedAt: sql`now() - interval '2 hours'` }).where(eq(schema.emailOutbox.id, outboxId));
    expect(await claimAndCollectOurs()).toContain(outboxId);
    const [claimed] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, outboxId));
    expect(claimed?.status).toBe("sending");

    // The last allowed attempt fails the row for good.
    await admin.update(schema.emailOutbox).set({ attempts: MAX_EMAIL_ATTEMPTS - 1 }).where(eq(schema.emailOutbox.id, outboxId));
    expect(await recordEmailFailure(admin, outboxId, "still down")).toBe("failed");
    const [terminal] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.id, outboxId));
    expect(terminal?.status).toBe("failed");
    expect(terminal?.attempts).toBe(MAX_EMAIL_ATTEMPTS);
  });
});
