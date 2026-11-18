import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import * as z from "zod";
import { db, schema, eq, and, gt } from "@kompast/db";
import { requireSystemAdmin, withAuthorizedTenant } from "@kompast/core";
import { getAuth } from "../auth";
import { requireAuthContext } from "../session";
import { attachInvitationDelivery, resendInvitationEmail } from "../invitation-delivery";

/**
 * member/user aren't RLS-scoped (they're Better Auth's own tables, same
 * exception class as apikey/invitation — see rls.sql) so this filters by
 * organizationId explicitly via plain `db`, matching the existing pattern
 * in server-fns/settings.ts (requireSystemAdmin(db, ctx), no
 * withAuthorizedTenant).
 */
export const listMembersFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  await requireSystemAdmin(db, ctx);

  const auth = await getAuth();
  const request = getRequest();

  const [members, invitations] = await Promise.all([
    db
      .select({ id: schema.member.id, userId: schema.member.userId, role: schema.member.role, name: schema.user.name, email: schema.user.email })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, ctx.organizationId)),
    auth.api.listInvitations({ query: { organizationId: ctx.organizationId }, headers: request.headers }),
  ]);

  const pending = invitations.filter((i) => i.status === "pending");
  // email_outbox is tenant-scoped, so the delivery lookup runs inside withAuthorizedTenant.
  const withDelivery = await withAuthorizedTenant(ctx, (tx) => attachInvitationDelivery(tx, ctx.organizationId, pending));

  return { members, invitations: withDelivery };
});

const inviteSchema = z.object({ email: z.email(), role: z.enum(["member", "admin"]) });

export const inviteMemberFn = createServerFn({ method: "POST" })
  .validator(inviteSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await requireSystemAdmin(db, ctx);

    const auth = await getAuth();
    const request = getRequest();
    const invitation = await auth.api.createInvitation({ body: { email: data.email, role: data.role, organizationId: ctx.organizationId }, headers: request.headers });
    return { id: invitation.id };
  });

export const cancelInvitationFn = createServerFn({ method: "POST" })
  .validator((invitationId: string) => invitationId)
  .handler(async ({ data: invitationId }) => {
    const ctx = await requireAuthContext();
    await requireSystemAdmin(db, ctx);

    const auth = await getAuth();
    const request = getRequest();
    await auth.api.cancelInvitation({ body: { invitationId }, headers: request.headers });
    return { ok: true } as const;
  });

/**
 * Re-sends a pending invitation's email (requeues its existing outbox row, or
 * sends it fresh if none exists). Same gate as inviteMemberFn/cancelInvitationFn.
 * The invitation must belong to the caller's workspace and still be pending and unexpired.
 */
export const resendInvitationFn = createServerFn({ method: "POST" })
  .validator((invitationId: string) => invitationId)
  .handler(async ({ data: invitationId }) => {
    const ctx = await requireAuthContext();
    await requireSystemAdmin(db, ctx);

    const [invitation] = await db
      .select({ id: schema.invitation.id, email: schema.invitation.email, role: schema.invitation.role })
      .from(schema.invitation)
      .where(
        and(
          eq(schema.invitation.id, invitationId),
          eq(schema.invitation.organizationId, ctx.organizationId),
          eq(schema.invitation.status, "pending"),
          gt(schema.invitation.expiresAt, new Date()),
        ),
      );
    if (!invitation) throw new Error("This invitation is no longer pending");

    await resendInvitationEmail(ctx, { id: invitation.id, email: invitation.email, role: invitation.role ?? "member" });
    return { ok: true } as const;
  });
