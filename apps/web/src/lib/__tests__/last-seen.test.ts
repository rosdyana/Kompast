import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { touchLastSeen, resetLastSeenThrottle, LAST_SEEN_THROTTLE_MS } from "../last-seen";

const USER_ID = "test-last-seen-user";

async function lastSeen() {
  const [row] = await admin.select({ lastSeenAt: schema.user.lastSeenAt }).from(schema.user).where(eq(schema.user.id, USER_ID));
  return row!.lastSeenAt;
}

describe("touchLastSeen", () => {
  beforeAll(async () => {
    await admin.delete(schema.user).where(eq(schema.user.id, USER_ID));
    await admin.insert(schema.user).values({ id: USER_ID, name: "Last Seen", email: "last-seen@test.kompast.local" });
  });
  afterAll(async () => {
    await admin.delete(schema.user).where(eq(schema.user.id, USER_ID));
  });
  beforeEach(async () => {
    resetLastSeenThrottle();
    await admin.update(schema.user).set({ lastSeenAt: null }).where(eq(schema.user.id, USER_ID));
  });

  it("sets last_seen_at when it was never recorded", async () => {
    const now = new Date();
    await touchLastSeen(USER_ID, now);
    expect((await lastSeen())?.getTime()).toBe(now.getTime());
  });

  it("doesn't rewrite a value newer than the throttle window, even from another process", async () => {
    const recent = new Date(Date.now() - 60_000);
    await admin.update(schema.user).set({ lastSeenAt: recent }).where(eq(schema.user.id, USER_ID));
    // Fresh in-process map, as a second web process would have.
    await touchLastSeen(USER_ID, new Date());
    expect((await lastSeen())?.getTime()).toBe(recent.getTime());
  });

  it("updates a value older than the throttle window", async () => {
    await admin.update(schema.user).set({ lastSeenAt: new Date(Date.now() - LAST_SEEN_THROTTLE_MS - 60_000) }).where(eq(schema.user.id, USER_ID));
    const now = new Date();
    await touchLastSeen(USER_ID, now);
    expect((await lastSeen())?.getTime()).toBe(now.getTime());
  });

  it("skips the DB within the window in the same process", async () => {
    const first = new Date();
    await touchLastSeen(USER_ID, first);
    // Clear the stored value behind its back; a throttled call must not touch the DB.
    await admin.update(schema.user).set({ lastSeenAt: null }).where(eq(schema.user.id, USER_ID));
    await touchLastSeen(USER_ID, new Date(first.getTime() + 1000));
    expect(await lastSeen()).toBeNull();
  });

  it("a throttled call returns the earlier in-flight write, so awaiting it sees the fresh value", async () => {
    const now = new Date();
    void touchLastSeen(USER_ID, now); // fire-and-forget, like getCurrentSession
    await touchLastSeen(USER_ID, new Date(now.getTime() + 10)); // like listMembersFn
    expect((await lastSeen())?.getTime()).toBe(now.getTime());
  });
});
