import { db, schema, eq, and, or, isNull, lt } from "@kompast/db";

/** At most one last_seen_at write per user per this window. */
export const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * userId → when this process last wrote (or decided not to need to write),
 * plus that write's promise, so a caller that must read its own fresh value
 * (listMembersFn) can await a write another call already started.
 */
const recentlyTouched = new Map<string, { at: number; write: Promise<void> }>();

/**
 * Records that `userId` just made an authenticated request, for the
 * Members tab's "Last active". user.lastLoginAt only moves on a new session
 * (sign-in), and sessions slide for 7 days, so it can't show recent use.
 *
 * Throttled twice: an in-process map skips the DB entirely within the window,
 * and the UPDATE itself is conditional on the stored value being older than
 * the window, so several web processes don't each write on every request.
 * Never rejects. Request paths fire it without awaiting — activity tracking
 * must not fail or slow down a request. Within the window it returns the
 * in-flight (or settled) write from the earlier call, so awaiting it always
 * means "this user's last_seen_at is now fresh".
 */
export function touchLastSeen(userId: string, now: Date = new Date()): Promise<void> {
  const last = recentlyTouched.get(userId);
  if (last !== undefined && now.getTime() - last.at < LAST_SEEN_THROTTLE_MS) return last.write;
  if (recentlyTouched.size > 10_000) recentlyTouched.clear();

  const cutoff = new Date(now.getTime() - LAST_SEEN_THROTTLE_MS);
  const write = db
    .update(schema.user)
    .set({ lastSeenAt: now })
    .where(and(eq(schema.user.id, userId), or(isNull(schema.user.lastSeenAt), lt(schema.user.lastSeenAt, cutoff))))
    .then(
      () => undefined,
      (err) => {
        recentlyTouched.delete(userId);
        console.error("[auth] failed to record last seen:", err);
      },
    );
  recentlyTouched.set(userId, { at: now.getTime(), write });
  return write;
}

/** Test-only: forget the in-process throttle. */
export function resetLastSeenThrottle() {
  recentlyTouched.clear();
}
