import { count, eq, schema } from "@kompast/db";
import type { AnyDb } from "./types";

/**
 * True when `userId` is the only user row in the whole deployment — used
 * by the Better Auth `databaseHooks.user.create.after` hook (apps/web/src/
 * lib/auth.ts) to decide whether a freshly-provisioned Entra sign-in
 * should auto-become the owner of a newly created workspace, versus a
 * later teammate who needs a real invite. Race note: two people completing
 * their very first sign-in in the same instant could both see count===1;
 * for a single-admin bootstrap this is a low-risk, accepted edge case, not
 * one this function tries to serialize against.
 */
export async function isOnlyUser(db: AnyDb, userId: string): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(schema.user);
  if (!row || row.n !== 1) return false;
  const [only] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId));
  return Boolean(only);
}
