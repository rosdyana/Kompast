import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
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
    await auth.api.acceptInvitation({ body: { invitationId }, headers: request.headers });
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
