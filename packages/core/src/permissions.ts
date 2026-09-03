import { and, eq } from "drizzle-orm";
import { schema, withTenant, db as defaultDb } from "@kompast/db";
import type { AnyDb, Tx } from "./types";

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export interface AuthContext {
  userId: string;
  organizationId: string;
}

/**
 * Verifies the user is actually a member of the organization before any
 * query runs. This is NOT redundant with RLS: RLS only checks that a row's
 * organization_id matches whatever `app.current_workspace` happens to be
 * set to — it has no idea whether the connecting user is entitled to *that*
 * workspace at all. If a caller derived organizationId from unchecked input
 * (a URL param, a client-supplied field) rather than from this check, RLS
 * would happily scope the query to a workspace the user was never a member
 * of. This function, not RLS, is what makes organizationId trustworthy.
 */
export async function requireMembership(
  db: AnyDb,
  ctx: AuthContext,
): Promise<{ role: string }> {
  const [row] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, ctx.organizationId),
        eq(schema.member.userId, ctx.userId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new ForbiddenError(`User ${ctx.userId} is not a member of organization ${ctx.organizationId}`);
  }
  return row;
}

/**
 * The actual "single enforcement point" callers should use: verifies
 * membership, then runs `fn` inside a withTenant() transaction scoped to
 * that (now-trusted) organizationId. Every mutation and every non-trivial
 * read in packages/core goes through this, never through `db` or
 * `withTenant` directly — see plan §Architecture, "Tenant isolation".
 */
export async function withAuthorizedTenant<T>(ctx: AuthContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireMembership(defaultDb, ctx);
  return withTenant(defaultDb, { organizationId: ctx.organizationId, userId: ctx.userId }, fn);
}

export async function requireProjectAccess(
  db: AnyDb,
  ctx: AuthContext & { projectId: string },
): Promise<void> {
  const [row] = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(and(eq(schema.project.id, ctx.projectId), eq(schema.project.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) {
    throw new ForbiddenError(`Project ${ctx.projectId} not found in organization ${ctx.organizationId}`);
  }
}
