import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, inArray, adminDb as admin } from "@kompast/db";
import type { Env } from "@kompast/env";
import { getDevAdminConfig, seedDevAdmin, buildAuth, DEV_ADMIN_EMAIL } from "../auth";

describe("getDevAdminConfig", () => {
  const base: Pick<Env, "NODE_ENV" | "ENABLE_DEV_LOGIN" | "DEV_ADMIN_PASSWORD"> = {
    NODE_ENV: "development",
    ENABLE_DEV_LOGIN: "false",
    DEV_ADMIN_PASSWORD: undefined,
  };

  it("is disabled by default", () => {
    expect(getDevAdminConfig(base).enabled).toBe(false);
  });

  it("stays disabled in production even if ENABLE_DEV_LOGIN is true", () => {
    const config = getDevAdminConfig({ ...base, NODE_ENV: "production", ENABLE_DEV_LOGIN: "true", DEV_ADMIN_PASSWORD: "a-dev-password" });
    expect(config.enabled).toBe(false);
  });

  it("throws when enabled but no password is set", () => {
    expect(() => getDevAdminConfig({ ...base, ENABLE_DEV_LOGIN: "true" })).toThrow(/DEV_ADMIN_PASSWORD/);
  });

  it("returns the password when properly enabled", () => {
    const config = getDevAdminConfig({ ...base, ENABLE_DEV_LOGIN: "true", DEV_ADMIN_PASSWORD: "a-dev-password" });
    expect(config).toEqual({ enabled: true, password: "a-dev-password" });
  });
});

describe("seedDevAdmin", () => {
  const otherUserId = "test-auth-other-user";

  async function cleanup() {
    const [user] = await admin.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, DEV_ADMIN_EMAIL));
    const userIds = [otherUserId, ...(user ? [user.id] : [])];
    const members = await admin.select({ organizationId: schema.member.organizationId }).from(schema.member).where(inArray(schema.member.userId, userIds));
    for (const id of userIds) {
      await admin.delete(schema.member).where(eq(schema.member.userId, id));
      await admin.delete(schema.session).where(eq(schema.session.userId, id));
      await admin.delete(schema.account).where(eq(schema.account.userId, id));
    }
    for (const m of members) {
      await admin.delete(schema.organization).where(eq(schema.organization.id, m.organizationId));
    }
    await admin.delete(schema.user).where(inArray(schema.user.id, userIds));
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  it("creates the fixed dev-admin user when none exists", async () => {
    const auth = buildAuth(null, true);
    await seedDevAdmin(auth, "a-dev-password-1234");

    const [user] = await admin.select().from(schema.user).where(eq(schema.user.email, DEV_ADMIN_EMAIL));
    expect(user?.name).toBe("Dev Admin");
  });

  it("is idempotent — calling it twice does not error or create a duplicate", async () => {
    const auth = buildAuth(null, true);
    await seedDevAdmin(auth, "a-dev-password-1234");
    await seedDevAdmin(auth, "a-dev-password-1234");

    const users = await admin.select().from(schema.user).where(eq(schema.user.email, DEV_ADMIN_EMAIL));
    expect(users).toHaveLength(1);
  });

  it("grants dev-admin its own organization (owner + super admin) even when it is NOT the only user in the table", async () => {
    // Simulates a leftover test fixture / scripts/seed-dev.ts's dev@example.com /
    // a real Entra sign-in already existing — any of which used to leave
    // dev-admin permanently org-less, since the databaseHooks "first user"
    // bootstrap hook only fires when the new user is the table's sole row.
    await admin.insert(schema.user).values({ id: otherUserId, name: "Other User", email: "other-user@example.com" });

    const auth = buildAuth(null, true);
    await seedDevAdmin(auth, "a-dev-password-1234");

    const [user] = await admin.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, DEV_ADMIN_EMAIL));
    const [membership] = await admin.select().from(schema.member).where(eq(schema.member.userId, user!.id));
    expect(membership?.role).toBe("owner");
    expect(membership?.isSuperAdmin).toBe(true);
  });
});
