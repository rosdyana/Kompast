import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, inArray, adminDb as admin } from "@kompast/db";
import type { Env } from "@kompast/env";
import { getDevAdminConfig, seedDevAdmin, buildAuth, DEV_ADMIN_EMAIL, isHttpBlockedAuthPath } from "../auth";

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

// Same file as seedDevAdmin's tests on purpose: both use the fixed dev-admin
// user, and vitest only serializes tests within one file (CLAUDE.md, Testing).
describe("Better Auth plugin REST surface is closed over HTTP", () => {
  const baseURL = process.env.BETTER_AUTH_URL!;

  // Its own throwaway user — NOT the shared dev-admin: every web test file
  // that calls getAuth() re-seeds dev-admin in parallel, which raced the
  // cleanup/sign-in here. Signed up through Better Auth itself so the
  // password/account rows are real.
  const EMAIL = `http-guard-${process.pid}-${Date.now()}@example.com`;
  const PASSWORD = "http-guard-password-1234";
  const ORG_ID = `test-http-guard-org-${process.pid}`;

  async function cleanupGuardUser() {
    const users = await admin.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, EMAIL));
    for (const u of users) {
      const members = await admin.select({ organizationId: schema.member.organizationId }).from(schema.member).where(eq(schema.member.userId, u.id));
      await admin.delete(schema.member).where(eq(schema.member.userId, u.id));
      await admin.delete(schema.session).where(eq(schema.session.userId, u.id));
      await admin.delete(schema.account).where(eq(schema.account.userId, u.id));
      for (const m of members) await admin.delete(schema.organization).where(eq(schema.organization.id, m.organizationId));
      await admin.delete(schema.user).where(eq(schema.user.id, u.id));
    }
    await admin.delete(schema.organization).where(eq(schema.organization.id, ORG_ID));
  }

  async function signedInGuardUser() {
    const auth = buildAuth(null, true);
    await auth.api.signUpEmail({ body: { email: EMAIL, password: PASSWORD, name: "HTTP Guard" } });
    const res = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const [user] = await admin.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, EMAIL));
    return { auth, cookie, userId: user!.id };
  }

  function post(path: string, cookie: string, body: unknown) {
    return new Request(`${baseURL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseURL, cookie },
      body: JSON.stringify(body),
    });
  }

  beforeEach(cleanupGuardUser);
  afterAll(cleanupGuardUser);

  it("isHttpBlockedAuthPath covers the organization and api-key plugins only", () => {
    expect(isHttpBlockedAuthPath("/organization/create")).toBe(true);
    expect(isHttpBlockedAuthPath("/organization/add-team-member")).toBe(true);
    expect(isHttpBlockedAuthPath("/api-key/create")).toBe(true);
    expect(isHttpBlockedAuthPath("/sign-in/email")).toBe(false);
    expect(isHttpBlockedAuthPath("/get-session")).toBe(false);
  });

  it("a signed-in user cannot create a workspace over HTTP", async () => {
    const { auth, cookie } = await signedInGuardUser();
    const res = await auth.handler(post("/organization/create", cookie, { name: "Mine", slug: "test-http-guard-org" }));
    expect(res.status).toBe(403);
    const [org] = await admin.select().from(schema.organization).where(eq(schema.organization.slug, "test-http-guard-org"));
    expect(org).toBeUndefined();
  });

  it("an owner cannot add themselves to a team over HTTP", async () => {
    const { auth, cookie } = await signedInGuardUser();
    const res = await auth.handler(post("/organization/add-team-member", cookie, { teamId: "any-team", userId: "any-user" }));
    expect(res.status).toBe(403);
  });

  it("a signed-in user cannot mint an API key over HTTP", async () => {
    const { auth, cookie } = await signedInGuardUser();
    const res = await auth.handler(post("/api-key/create", cookie, { name: "sneaky" }));
    expect(res.status).toBe(403);
  });

  it("even a direct session-bound auth.api.createOrganization is refused (allowUserToCreateOrganization: false)", async () => {
    const { auth, cookie } = await signedInGuardUser();
    await expect(auth.api.createOrganization({ headers: new Headers({ cookie }), body: { name: "Mine", slug: "test-http-guard-org-2" } })).rejects.toThrow();
  });

  it("server-side auth.api calls (no request) still work — e.g. listing invitations", async () => {
    const { auth, cookie, userId } = await signedInGuardUser();
    await admin.insert(schema.organization).values({ id: ORG_ID, name: "HTTP Guard Org", slug: ORG_ID });
    await admin.insert(schema.member).values({ id: `mem-${ORG_ID}`, organizationId: ORG_ID, userId, role: "owner" });
    const invitations = await auth.api.listInvitations({ headers: new Headers({ cookie }), query: { organizationId: ORG_ID } });
    expect(Array.isArray(invitations)).toBe(true);
  });
});
