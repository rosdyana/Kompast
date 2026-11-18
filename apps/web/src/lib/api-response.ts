import { ApiError } from "./api-auth";
import { classifyError } from "./public-error";

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Wraps every /api/v1 handler so any thrown error (ours, packages/core's, or a raw bug) still comes back as RFC 9457 problem+json, never an unhandled 500 HTML page. */
export async function handleApiRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    // ApiError carries its own headers/extra, so it is returned as-is.
    if (err instanceof ApiError) return err.toResponse();
    // Known caller-facing errors (validation, not-found, conflict, ...) map to their status; see public-error.ts.
    const mapped = classifyError(err);
    if (mapped) return new ApiError(mapped.status, mapped.title, mapped.message).toResponse();
    // eslint-disable-next-line no-console
    console.error("[api/v1] unhandled error:", err);
    return new ApiError(500, "Internal Server Error", "Unexpected error").toResponse();
  }
}
