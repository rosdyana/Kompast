import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import * as z from "zod";
import { getAuth } from "../auth";
import { requireAuthContext } from "../session";

/**
 * The scopes a user can actually grant a token today — kept in lockstep
 * with what packages/core exposes through REST/MCP (see
 * apps/web/src/lib/api-auth.ts). Add to this list only once the
 * corresponding surface exists; an unusable scope in the UI is worse than
 * no scope at all.
 */
export const TOKEN_SCOPES = ["issues:read", "issues:write", "pages:read", "pages:write", "admin"] as const;

function scopesToPermissions(scopes: string[]): Record<string, string[]> {
  const perms: Record<string, string[]> = {};
  for (const scope of scopes) {
    const [resource, action] = scope.split(":");
    if (!resource || !action) continue;
    (perms[resource] ??= []).push(action);
  }
  return perms;
}

const createTokenSchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
  expiresInDays: z.number().int().positive().nullable().optional(),
});

/** Raw token is returned once — the caller must show it immediately and never persist it client-side. */
export const createTokenFn = createServerFn({ method: "POST" })
  .validator(createTokenSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    const auth = await getAuth();
    const result = await auth.api.createApiKey({
      body: {
        name: data.name,
        userId: ctx.userId,
        prefix: "kmp_",
        permissions: scopesToPermissions(data.scopes),
        metadata: { organizationId: ctx.organizationId },
        expiresIn: data.expiresInDays ? data.expiresInDays * 86400 : null,
      },
    });
    return { id: result.id, token: result.key, name: result.name, createdAt: result.createdAt };
  });

export const listTokensFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireAuthContext();
  const auth = await getAuth();
  const request = getRequest();
  const { apiKeys } = await auth.api.listApiKeys({ headers: request.headers });
  return apiKeys.map((k) => ({
    id: k.id,
    name: k.name,
    start: k.start,
    permissions: (k.permissions ?? null) as Record<string, string[]> | null,
    enabled: k.enabled,
    expiresAt: k.expiresAt,
    lastRequest: k.lastRequest,
    createdAt: k.createdAt,
  }));
});

export const revokeTokenFn = createServerFn({ method: "POST" })
  .validator((keyId: string) => keyId)
  .handler(async ({ data: keyId }) => {
    await requireAuthContext();
    const auth = await getAuth();
    const request = getRequest();
    await auth.api.deleteApiKey({ body: { keyId }, headers: request.headers });
    return { ok: true } as const;
  });
