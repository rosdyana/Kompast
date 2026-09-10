import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
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
  async function cleanup() {
    const [user] = await admin.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, DEV_ADMIN_EMAIL));
    if (!user) return;
    const members = await admin
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, user.id));
    await admin.delete(schema.member).where(eq(schema.member.userId, user.id));
    await admin.delete(schema.session).where(eq(schema.session.userId, user.id));
    await admin.delete(schema.account).where(eq(schema.account.userId, user.id));
    for (const m of members) {
      await admin.delete(schema.organization).where(eq(schema.organization.id, m.organizationId));
    }
    await admin.delete(schema.user).where(eq(schema.user.id, user.id));
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
});
