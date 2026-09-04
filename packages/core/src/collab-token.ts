import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "@kompast/env";

export interface CollabTokenPayload {
  userId: string;
  organizationId: string;
  pageId: string;
  role: "view" | "comment" | "edit" | "full";
  exp: number;
}

/**
 * Short-lived, HMAC-signed proof that a specific user already passed a
 * page access check (packages/core/page-permission.ts) for a specific
 * page. apps/web mints one per editor mount; apps/collab verifies it in
 * onAuthenticate instead of querying Postgres for a workspace session it
 * has no way to derive a GUC from — same trust model the local storage
 * driver already uses for signed attachment URLs (see packages/storage).
 */
function getSecret(): string {
  return loadEnv().BETTER_AUTH_SECRET;
}

export function signCollabToken(payload: Omit<CollabTokenPayload, "exp">, ttlSeconds = 60): string {
  const full: CollabTokenPayload = { ...payload, exp: Date.now() + ttlSeconds * 1000 };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  const signature = createHmac("sha256", getSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyCollabToken(token: string): CollabTokenPayload | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = createHmac("sha256", getSecret()).update(body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: CollabTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (payload.exp < Date.now()) return null;
  return payload;
}
