import { getRequest } from "@tanstack/react-start/server";
import { getAuth } from "./auth";

/**
 * Resolves the authenticated user + their active workspace for the current
 * request. This is the ONLY place that should call `auth.api.getSession` —
 * every server function needing auth goes through this, then passes the
 * result into @kompast/core as an AuthContext. Must be called inside a
 * server function's `.handler()`, never at module scope (see start-core's
 * auth-server-primitives guidance: request-bound helpers don't exist yet
 * outside of a request).
 */
export async function getCurrentSession() {
  const request = getRequest();
  const auth = await getAuth();
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result) return null;

  const organizationId = result.session.activeOrganizationId;
  if (!organizationId) return { ...result, organizationId: null as string | null };

  return { ...result, organizationId };
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("No active session");
    this.name = "UnauthenticatedError";
  }
}

export class NoActiveWorkspaceError extends Error {
  constructor() {
    super("Session has no active workspace");
    this.name = "NoActiveWorkspaceError";
  }
}

/** Throws instead of returning null/undefined — for handlers where an anonymous or workspace-less request is simply a bug, not a valid state to render around. */
export async function requireAuthContext(): Promise<{ userId: string; organizationId: string }> {
  const session = await getCurrentSession();
  if (!session) throw new UnauthenticatedError();
  if (!session.organizationId) throw new NoActiveWorkspaceError();
  return { userId: session.user.id, organizationId: session.organizationId };
}
