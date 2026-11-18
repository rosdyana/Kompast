import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, db, adminDb as admin } from "@kompast/db";
import { id } from "@kompast/core/ids";
import { recordEmailFailure, withAuthorizedTenant } from "@kompast/core";
import { sendInvitationEmail } from "../auth";
import { attachInvitationDelivery, resendInvitationEmail } from "../invitation-delivery";
import { listPendingInvitationsForEmail } from "../invitation-delivery";
import { workspaceEntryFor } from "../server-fns/workspace";

describe("sendInvitationEmail", () => {
  const orgId = "test-invite-org";
  const inviterId = "test-invite-inviter";

  async function cleanup() {
    await admin.delete(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, inviterId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Invite Test Org", slug: orgId });
    await admin.insert(schema.user).values({ id: inviterId, name: "Inviter Name", email: `${inviterId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId: inviterId, role: "owner" });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("enqueues one email_outbox row with the notification template shape and an accept-invitation URL", async () => {
    const invitationId = id("inv");
    await sendInvitationEmail({
      id: invitationId,
      role: "member",
      email: "invitee@example.com",
      organization: { id: orgId, name: "Invite Test Org" },
      inviter: { userId: inviterId, user: { name: "Inviter Name" } },
    });

    const [outboxRow] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.dedupeKey, `invitation:${invitationId}`));
    expect(outboxRow?.organizationId).toBe(orgId);
    expect(outboxRow?.toEmail).toBe("invitee@example.com");
    expect(outboxRow?.templateKey).toBe("notification");
    const props = outboxRow?.templateProps as { title: string; body: string; actionUrl: string; actionLabel: string };
    expect(props.title).toContain("Invite Test Org");
    expect(props.body).toContain("Inviter Name");
    expect(props.actionUrl).toContain(`/invite/${invitationId}`);
    expect(props.actionLabel).toBe("Accept invitation");
  });

  it("is idempotent per invitation id — calling it twice for the same invitation enqueues only one email", async () => {
    const invitationId = id("inv");
    const call = () =>
      sendInvitationEmail({
        id: invitationId,
        role: "member",
        email: "invitee@example.com",
        organization: { id: orgId, name: "Invite Test Org" },
        inviter: { userId: inviterId, user: { name: "Inviter Name" } },
      });
    await call();
    await call();

    const rows = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.dedupeKey, `invitation:${invitationId}`));
    expect(rows).toHaveLength(1);
  });
});

describe("invitation table RLS", () => {
  const orgId = "test-invite-rls-org";
  const inviterId = "test-invite-rls-inviter";

  async function cleanup() {
    await admin.delete(schema.invitation).where(eq(schema.invitation.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, inviterId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  afterAll(cleanup);

  it("is readable via the plain app-role connection with no workspace GUC set (RLS deliberately disabled — see rls.sql)", async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Invite RLS Org", slug: orgId });
    await admin.insert(schema.user).values({ id: inviterId, name: "Inviter", email: `${inviterId}@example.com` });
    const invitationId = id("inv");
    await admin.insert(schema.invitation).values({
      id: invitationId,
      organizationId: orgId,
      email: "someone@example.com",
      role: "member",
      status: "pending",
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId,
    });

    const [row] = await db.select().from(schema.invitation).where(eq(schema.invitation.id, invitationId));
    expect(row?.email).toBe("someone@example.com");
  });
});

describe("invitation delivery status, resend, and the no-workspace landing", () => {
  const orgId = "test-invite-deliv-org";
  const inviterId = "test-invite-deliv-inviter";
  const ctx = { userId: inviterId, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    await admin.delete(schema.invitation).where(eq(schema.invitation.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, inviterId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Delivery Org", slug: orgId });
    await admin.insert(schema.user).values({ id: inviterId, name: "Deliverer", email: `${inviterId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId: inviterId, role: "owner" });
  });

  afterAll(cleanup);

  async function invite(invitationId: string, email: string) {
    await sendInvitationEmail({
      id: invitationId,
      role: "member",
      email,
      organization: { id: orgId, name: "Delivery Org" },
      inviter: { userId: inviterId, user: { name: "Deliverer" } },
    });
  }

  async function outboxIdFor(invitationId: string) {
    const [row] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.dedupeKey, `invitation:${invitationId}`));
    return row!.id;
  }

  it("attachInvitationDelivery joins each invitation to its outbox row, null when it has none, and adds the accept link", async () => {
    const queuedId = id("inv");
    const failingId = id("inv");
    const noRowId = id("inv");
    await invite(queuedId, "deliv-queued@example.com");
    await invite(failingId, "deliv-failing@example.com");
    await recordEmailFailure(admin, await outboxIdFor(failingId), "vendor rejected sender");

    const rows = await withAuthorizedTenant(ctx, (tx) =>
      attachInvitationDelivery(tx, orgId, [{ id: queuedId }, { id: failingId }, { id: noRowId }]),
    );

    expect(rows[0]!.delivery).toEqual({ state: "queued", error: null, attempts: 0 });
    expect(rows[1]!.delivery).toEqual({ state: "failing", error: "vendor rejected sender", attempts: 1 });
    expect(rows[2]!.delivery).toBeNull();
    expect(rows[0]!.inviteUrl).toMatch(new RegExp(`/invite/${queuedId}$`));
  });

  it("resendInvitationEmail requeues the existing row (same dedupeKey, no second row) when one exists", async () => {
    const invitationId = id("inv");
    await invite(invitationId, "deliv-resend@example.com");
    await recordEmailFailure(admin, await outboxIdFor(invitationId), "smtp down");

    await resendInvitationEmail(ctx, { id: invitationId, email: "deliv-resend@example.com", role: "member" });

    const rows = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.dedupeKey, `invitation:${invitationId}`));
    expect(rows).toHaveLength(1);
    // Status is not asserted: a requeued row is claimable at once and may already be "sending".
    expect(rows[0]).toMatchObject({ attempts: 0, error: null });
  });

  it("resendInvitationEmail sends a fresh email when the invitation has no outbox row yet", async () => {
    const invitationId = id("inv");
    await resendInvitationEmail(ctx, { id: invitationId, email: "deliv-fresh@example.com", role: "admin" });

    const [row] = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.dedupeKey, `invitation:${invitationId}`));
    expect(row?.toEmail).toBe("deliv-fresh@example.com");
    expect((row?.templateProps as { body: string }).body).toContain("Deliverer");
  });

  it("listPendingInvitationsForEmail returns only this email's pending, unexpired invitations, matching case-insensitively", async () => {
    const otherOrgId = "test-invite-deliv-other-org";
    await admin.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));
    await admin.insert(schema.organization).values({ id: otherOrgId, name: "Other Org", slug: otherOrgId });

    const pendingId = id("inv");
    const expiredId = id("inv");
    const acceptedId = id("inv");
    const otherEmailId = id("inv");
    const future = new Date(Date.now() + 86_400_000);
    const past = new Date(Date.now() - 86_400_000);
    await admin.insert(schema.invitation).values([
      { id: pendingId, organizationId: orgId, email: "Deliv-Lookup@Example.com", role: "member", status: "pending", expiresAt: future, inviterId },
      { id: expiredId, organizationId: orgId, email: "deliv-lookup@example.com", role: "member", status: "pending", expiresAt: past, inviterId },
      { id: acceptedId, organizationId: otherOrgId, email: "deliv-lookup@example.com", role: "member", status: "accepted", expiresAt: future, inviterId },
      { id: otherEmailId, organizationId: otherOrgId, email: "someone-else-deliv@example.com", role: "admin", status: "pending", expiresAt: future, inviterId },
    ]);

    try {
      const found = await listPendingInvitationsForEmail("deliv-lookup@EXAMPLE.com");
      expect(found).toEqual([{ id: pendingId, organizationName: "Delivery Org", role: "member" }]);
    } finally {
      await admin.delete(schema.invitation).where(eq(schema.invitation.organizationId, otherOrgId));
      await admin.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));
    }
  });

  it("workspaceEntryFor sends a signed-in user with no active workspace to noWorkspace, not anonymous", () => {
    expect(workspaceEntryFor(null)).toEqual({ kind: "anonymous" });
    expect(workspaceEntryFor({ organizationId: null })).toEqual({ kind: "noWorkspace" });
    expect(workspaceEntryFor({ organizationId: orgId })).toMatchObject({ kind: "workspace", session: { organizationId: orgId } });
  });
});
