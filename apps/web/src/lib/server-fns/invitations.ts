import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { applyAcceptedTeamInvitation } from "@kompast/core";
import { withTenant, adminDb } from "@kompast/db";
import { getAuth } from "../auth";
import { listPendingInvitationsForEmail } from "../invitation-delivery";

// Server-fn files must export only server functions. A plain exported helper
// that touches `db` keeps @kompast/db (postgres.js) in the *browser* bundle,
// which crashes every page with "Buffer is not defined". DB helpers belong in
// a server-only module (../invitation-delivery) used inside handlers.

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
