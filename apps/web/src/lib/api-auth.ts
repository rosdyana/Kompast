import { getAuth } from "./auth";
import { requireMembership, ForbiddenError } from "@kompast/core";
import { db } from "@kompast/db";

export interface ApiAuthContext {
  userId: string;
  organizationId: string;
  scopes: Record<string, string[]>;
  apiKeyId: string;
  /** From packages/core/attribution — every REST/MCP mutation is recorded with this, never "user". */
  origin: "api" | "mcp";
}

/**
 * RFC 9457 problem+json — every REST and MCP-auth error responds with
 * this shape, not a bare string or an ad hoc JSON object.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail: string,
    public extra?: Record<string, unknown>,
  ) {
    super(detail);
    this.name = "ApiError";
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({ type: "about:blank", title: this.title, status: this.status, detail: this.detail, ...this.extra }),
      { status: this.status, headers: { "Content-Type": "application/problem+json" } },
    );
  }
}

/**
 * A token whose stored `permissions` don't satisfy the scope we asked
 * verifyApiKey to check comes back as KEY_NOT_FOUND, not a distinct
 * "forbidden" code — confirmed by reading @better-auth/api-key's own
 * validateApiKey (it deliberately doesn't distinguish "wrong scope" from
 * "no such key", presumably so a client can't probe for a token's
 * existence by scope-guessing). INSUFFICIENT_API_KEY_PERMISSIONS is a
 * real code in the same package, but for a different endpoint entirely
 * (organization-permission checks on api-key management itself) — it
 * will never actually come back from verifyApiKey, mapped here only so a
 * future library version doing so wouldn't fall through to a bare 401.
 */
const VERIFY_ERROR_STATUS: Record<string, number> = {
  KEY_NOT_FOUND: 401,
  INVALID_API_KEY: 401,
  KEY_EXPIRED: 401,
  KEY_DISABLED: 401,
  KEY_DISABLED_EXPIRATION: 401,
  USAGE_EXCEEDED: 429,
  RATE_LIMIT_EXCEEDED: 429,
  INSUFFICIENT_API_KEY_PERMISSIONS: 403,
  USER_BANNED: 403,
};

function scopeToPermissions(scope: string): Record<string, string[]> {
  const [resource, action] = scope.split(":");
  return resource && action ? { [resource]: [action] } : {};
}

/**
 * Verifies a Bearer PAT and returns the same {userId, organizationId}
 * shape requireAuthContext() gives UI server functions — every
 * packages/core call downstream is identical regardless of which surface
 * (UI, REST, MCP) is calling it, which is the entire point of the
 * single-service-layer architecture (see plan §"REST API + MCP").
 * `origin` is "mcp" for calls arriving from /mcp, "api" otherwise —
 * callers pass it through to attribution-aware packages/core functions
 * (origin/originClient columns) so activity reads e.g. "via Claude Code",
 * not silently as "user".
 */
export async function requireApiAuth(
  request: Request,
  requiredScope: string | undefined,
  origin: "api" | "mcp",
): Promise<ApiAuthContext> {
  const authHeader = request.headers.get("authorization") ?? "";
  const match = /^Bearer (.+)$/i.exec(authHeader);
  if (!match) {
    throw new ApiError(401, "Unauthorized", "Missing Authorization: Bearer <token> header");
  }
  const token = match[1]!;

  const auth = await getAuth();
  const result = await auth.api.verifyApiKey({
    body: { key: token, permissions: requiredScope ? scopeToPermissions(requiredScope) : undefined },
  });

  if (!result.valid || !result.key) {
    const code = result.error?.code ?? "INVALID_API_KEY";
    const status = VERIFY_ERROR_STATUS[code] ?? 401;
    throw new ApiError(status, "Unauthorized", String(result.error?.message ?? "Invalid or expired token"), { code });
  }

  const organizationId = (result.key.metadata as { organizationId?: string } | null)?.organizationId;
  if (!organizationId) {
    throw new ApiError(401, "Unauthorized", "Token is not bound to a workspace");
  }

  try {
    await requireMembership(db, { userId: result.key.referenceId, organizationId });
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new ApiError(401, "Unauthorized", "Token owner is no longer a member of this workspace");
    }
    throw err;
  }

  return {
    userId: result.key.referenceId,
    organizationId,
    scopes: (result.key.permissions ?? {}) as Record<string, string[]>,
    apiKeyId: result.key.id,
    origin,
  };
}
