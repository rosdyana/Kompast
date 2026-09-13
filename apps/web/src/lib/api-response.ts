import { ApiError } from "./api-auth";
import { ForbiddenError, AutomationGraphError } from "@kompast/core";

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Wraps every /api/v1 handler so any thrown error (ours, packages/core's, or a raw bug) still comes back as RFC 9457 problem+json, never an unhandled 500 HTML page. */
export async function handleApiRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) return err.toResponse();
    if (err instanceof ForbiddenError) return new ApiError(403, "Forbidden", err.message).toResponse();
    // A save-time graph validation failure (dangling edge, unreachable
    // node, an unsupported schedule-trigger downstream node, a malformed
    // cron string) is a client input error, not a server bug — surface the
    // real reason as a 400 instead of falling through to a generic 500.
    if (err instanceof AutomationGraphError) return new ApiError(400, "Bad Request", err.message).toResponse();
    // eslint-disable-next-line no-console
    console.error("[api/v1] unhandled error:", err);
    return new ApiError(500, "Internal Server Error", "Unexpected error").toResponse();
  }
}
