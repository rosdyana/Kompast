import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, db, adminDb as admin } from "@kompast/db";
import { id } from "@kompast/core/ids";
import { sendInvitationEmail } from "../auth";

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
    expect(props.actionLabel).toBe("Terima undangan");
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
