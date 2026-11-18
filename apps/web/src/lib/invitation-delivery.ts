import { getEmailDeliveryByDedupeKeys, retryEmail, withAuthorizedTenant, type Tx } from "@kompast/core";
import { db, schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import { sendInvitationEmail } from "./auth";

/** The outbox dedupeKey sendInvitationEmail writes for an invitation. Keep in sync with lib/auth.ts. */
export function invitationDedupeKey(invitationId: string) {
  return `invitation:${invitationId}`;
}

/**
 * Joins each invitation to its email_outbox row (delivery state, or null for
 * an invite that has no row, e.g. created before mail worked) and adds the
 * copyable accept link, built from APP_URL exactly like the emailed one.
 * Tenant-scoped: call inside withAuthorizedTenant.
 */
export async function attachInvitationDelivery<T extends { id: string }>(tx: Tx, organizationId: string, invitations: T[]) {
  const deliveries = await getEmailDeliveryByDedupeKeys(
    tx,
    organizationId,
    invitations.map((i) => invitationDedupeKey(i.id)),
  );
  const appUrl = loadEnv().APP_URL;
  return invitations.map((i) => ({
    ...i,
    delivery: deliveries.get(invitationDedupeKey(i.id)) ?? null,
    inviteUrl: `${appUrl}/invite/${i.id}`,
  }));
}

/**
 * Resend an invitation's email. If its outbox row exists, requeue that row
 * (same dedupeKey, so the delivery badge stays exact). If not, send it fresh
 * through sendInvitationEmail, recording the resending admin as inviter —
 * the same as inviteToTeamFn does for a new invite. The caller has already
 * passed the gate (requireSystemAdmin / requireTeamAdmin) and checked the
 * invitation is pending and belongs to the caller's workspace (and team).
 */
export async function resendInvitationEmail(
  caller: { userId: string; organizationId: string },
  invitation: { id: string; email: string; role: string },
) {
  const requeued = await withAuthorizedTenant(caller, (tx) => retryEmail(tx, caller.organizationId, invitationDedupeKey(invitation.id)));
  if (requeued) return;

  const [org] = await db
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, caller.organizationId));
  const [inviter] = await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, caller.userId));
  await sendInvitationEmail({
    id: invitation.id,
    role: invitation.role,
    email: invitation.email,
    organization: org!,
    inviter: { userId: caller.userId, user: { name: inviter?.name ?? "" } },
  });
}
