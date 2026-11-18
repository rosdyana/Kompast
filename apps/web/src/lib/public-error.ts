import { ZodError } from "zod";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { APIError as BetterAuthAPIError } from "better-auth/api";
import {
  AiNotConfiguredError,
  AutomationGraphError,
  ConflictError,
  DisallowedOutboundUrlError,
  EmbeddingNotConfiguredError,
  ForbiddenError,
  IdempotencyInProgressError,
  InvalidInputError,
  NotFoundError,
  PageSpaceError,
  ProjectKeyConflictError,
  TeamDeleteError,
  TeamInvitationError,
  TeamNameError,
  UserFacingError,
  WorkspaceNameError,
} from "@kompast/core";
import { ApiError } from "./api-auth";
import { NoActiveWorkspaceError, UnauthenticatedError } from "./session";

/**
 * SERVER-ONLY. Never import this from a component, hook or server-fn file's
 * client-reachable code: it pulls in api-auth/session (auth + db). Client code
 * that needs the reference prefix duplicates GENERIC_ERROR_PREFIX locally.
 *
 * Maps errors to HTTP-like status/title/message. Anything listed here was
 * written for the caller, so its message is safe to show. Anything not listed
 * is an internal error whose raw text must never reach the browser.
 */
export function classifyError(err: unknown): { status: number; title: string; message: string } | null {
  if (err instanceof ApiError) return { status: err.status, title: err.title, message: err.detail };
  if (err instanceof ForbiddenError) return { status: 403, title: "Forbidden", message: err.message };
  // A save-time graph validation failure (dangling edge, unreachable node,
  // malformed cron string) is a client input error, not a server bug.
  if (err instanceof AutomationGraphError) return { status: 400, title: "Bad Request", message: err.message };
  // Conflicting spaces (e.g. private + teamId), a child in a different space
  // from its parent, sharing a private page.
  if (err instanceof PageSpaceError) return { status: 400, title: "Bad Request", message: err.message };
  if (err instanceof NotFoundError) return { status: 404, title: "Not Found", message: err.message };
  if (err instanceof ConflictError) return { status: 409, title: "Conflict", message: err.message };
  if (err instanceof InvalidInputError) return { status: 400, title: "Bad Request", message: err.message };
  // Request-body validation (schema.parse(await request.json())).
  if (err instanceof ZodError) {
    return {
      status: 400,
      title: "Bad Request",
      message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
    };
  }
  if (err instanceof UserFacingError) return { status: 400, title: "Bad Request", message: err.message };
  if (err instanceof TeamNameError) return { status: 400, title: "Bad Request", message: err.message };
  if (err instanceof TeamDeleteError) return { status: 409, title: "Conflict", message: err.message };
  if (err instanceof TeamInvitationError) return { status: 400, title: "Bad Request", message: err.message };
  if (err instanceof WorkspaceNameError) return { status: 400, title: "Bad Request", message: err.message };
  if (err instanceof ProjectKeyConflictError) return { status: 409, title: "Conflict", message: err.message };
  if (err instanceof AiNotConfiguredError) return { status: 400, title: "Bad Request", message: err.message };
  if (err instanceof EmbeddingNotConfiguredError) return { status: 400, title: "Bad Request", message: err.message };
  if (err instanceof IdempotencyInProgressError) return { status: 409, title: "Conflict", message: err.message };
  if (err instanceof UnauthenticatedError) return { status: 401, title: "Unauthorized", message: err.message };
  if (err instanceof NoActiveWorkspaceError) return { status: 400, title: "Bad Request", message: err.message };
  // Outbound-URL guard ("Only http(s) URLs are allowed", private-network targets): the caller's input.
  if (err instanceof DisallowedOutboundUrlError) return { status: 400, title: "Bad Request", message: err.message };
  // Better Auth's own 4xx errors from auth.api.* calls (invitations, members, API tokens), e.g.
  // "User is already a member of this organization". Its 5xx stay internal.
  if (err instanceof BetterAuthAPIError && err.statusCode < 500) {
    return { status: err.statusCode, title: String(err.status).replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), message: err.message };
  }
  return null;
}

const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Short correlation ID shown to users and written to the server log, e.g. "K7F3-9QX2". Unambiguous alphabet: no 0/O, 1/I/L. */
export function newErrorReference(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Prefix of the message a sanitized internal error carries. Client code matches it: see ErrorPage.tsx (kept as a duplicate there because this module is server-only). */
export const GENERIC_ERROR_PREFIX = "Something went wrong. Reference: ";

/**
 * Returns the error the browser should see. TanStack control flow
 * (redirect/notFound) and known caller-facing errors pass through unchanged;
 * everything else is logged in full under a reference ID and replaced by a
 * generic error that carries only that ID.
 */
export function toPublicError(err: unknown): unknown {
  if (isRedirect(err) || isNotFound(err)) return err;
  if (classifyError(err)) return err;
  const ref = newErrorReference();
  // eslint-disable-next-line no-console
  console.error("[server-fn] unhandled error", ref, err);
  return new Error(GENERIC_ERROR_PREFIX + ref);
}
