import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { applyAcceptedTeamInvitation } from "@kompast/core";
import { withTenant, adminDb, db, schema, and, eq, sql } from "@kompast/db";
import { getAuth } from "../auth";

/**
 * Deliberately NOT gated by requireAuthContext() (Kompast's own
 * membership check) — someone accepting an invitation is by definition
 * not yet a member, so that check would always fail for them. These call
 * Better Auth's session/invitation endpoints directly instead; the real
 * authorization is acceptInvitation's own internal check that the
 * accepting session's email matches the invitation's email.
 */
export const getInvitationStatusFn = createServerFn({ method: "GET" })
  .validator((invitationId: string) => invitationId)
  .handler(async ({ data: invitationId }) => {
    const auth = await getAuth();
    const request = getRequest();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return { requiresLogin: true as const };

    const invitation = await auth.api.getInvitation({ query: { id: invitationId }, headers: request.headers });
    return {
      requiresLogin: false as const,
      invitation: { id: invitation.id, organizationName: invitation.organizationName, role: invitation.role, status: invitation.status, email: invitation.email },
      currentUserEmail: session.user.email,
      emailMatches: invitation.email.toLowerCase() === session.user.email.toLowerCase(),
    };
  });

export const acceptInvitationFn = createServerFn({ method: "POST" })
  .validator((invitationId: string) => invitationId)
  .handler(async ({ data: invitationId }) => {
    const auth = await getAuth();
    const request = getRequest();
    const { invitation, member } = await auth.api.acceptInvitation({ body: { invitationId }, headers: request.headers });
    // Team invitations carry a team role the plugin doesn't know about.
    // withTenant on adminDb, not withAuthorizedTenant: invitation/team_member
    // have no RLS, and this is the one moment the accepting user's own
    // membership is brand new (same request) — no need to re-derive it.
    await withTenant(adminDb, { organizationId: invitation.organizationId, userId: member.userId }, (tx) =>
      applyAcceptedTeamInvitation(tx, { invitationId, userId: member.userId }),
    );
    return { ok: true } as const;
  });

export const rejectInvitationFn = createServerFn({ method: "POST" })
  .validator((invitationId: string) => invitationId)
  .handler(async ({ data: invitationId }) => {
    const auth = await getAuth();
    const request = getRequest();
    await auth.api.rejectInvitation({ body: { invitationId }, headers: request.headers });
    return { ok: true } as const;
  });

/**
 * Pending, unexpired invitations addressed to this email (case-insensitive),
 * across every workspace. Plain `db`, not withAuthorizedTenant: the invitation
 * table has RLS disabled (rls.sql), and the signed-in user has no workspace
 * yet, so there is no tenant to scope to. Callers must pass the session's own email.
 */
export async function listPendingInvitationsForEmail(email: string) {
  return db
    .select({ id: schema.invitation.id, organizationName: schema.organization.name, role: schema.invitation.role })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
    .where(
      and(
        sql`lower(${schema.invitation.email}) = lower(${email})`,
        eq(schema.invitation.status, "pending"),
        sql`${schema.invitation.expiresAt} > now()`,
      ),
    )
    .orderBy(schema.invitation.createdAt);
}

/**
 * Backs /no-workspace: a signed-in user with no workspace lists the invitations
 * waiting for their email. Not gated by requireAuthContext (they have no
 * workspace by definition); the session is the only identity used, and it
 * only ever returns invitations for that session's own email.
 */
export const listMyPendingInvitationsFn = createServerFn({ method: "GET" }).handler(async () => {
  const auth = await getAuth();
  const request = getRequest();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;

  const invitations = await listPendingInvitationsForEmail(session.user.email);
  return { email: session.user.email, invitations };
});
