import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, adminDb as admin } from "@kompast/db";
import { getAuth } from "../auth";
import { requireApiAuth, ApiError } from "../api-auth";
import { id } from "@kompast/core/ids";

function req(token?: string) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/api/v1/issues", { headers });
}

describe("requireApiAuth", () => {
  const orgId = "test-apiauth-org";
  const otherOrgId = "test-apiauth-other-org";
  const userId = "test-apiauth-user";

  async function cleanup() {
    await admin.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values([
      { id: orgId, name: "API Auth Org", slug: orgId },
      { id: otherOrgId, name: "Other Org", slug: otherOrgId },
    ]);
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
  });

  it("accepts a valid token scoped to a workspace the user belongs to", async () => {
    const auth = await getAuth();
    const { key } = await auth.api.createApiKey({
      body: { userId, permissions: { issues: ["read", "write"] }, metadata: { organizationId: orgId } },
    });

    const ctx = await requireApiAuth(req(key), "issues:read", "api");
    expect(ctx.userId).toBe(userId);
    expect(ctx.organizationId).toBe(orgId);
    expect(ctx.scopes).toEqual({ issues: ["read", "write"] });
  });

  it("rejects a missing Authorization header", async () => {
    await expect(requireApiAuth(req(), undefined, "api")).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a garbage token", async () => {
    await expect(requireApiAuth(req("not-a-real-token"), undefined, "api")).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a token missing the required scope (reported as 401, same as an unknown key — the plugin never distinguishes the two)", async () => {
    const auth = await getAuth();
    const { key } = await auth.api.createApiKey({
      body: { userId, permissions: { issues: ["read"] }, metadata: { organizationId: orgId } },
    });

    const err = await requireApiAuth(req(key), "issues:write", "api").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  it("rejects a token bound to a workspace the user is no longer a member of", async () => {
    const auth = await getAuth();
    const { key } = await auth.api.createApiKey({
      body: { userId, permissions: {}, metadata: { organizationId: otherOrgId } },
    });

    await expect(requireApiAuth(req(key), undefined, "api")).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a revoked token", async () => {
    const auth = await getAuth();
    const created = await auth.api.createApiKey({
      body: { userId, permissions: {}, metadata: { organizationId: orgId } },
    });
    await admin.delete(schema.apikey).where(eq(schema.apikey.id, created.id));

    await expect(requireApiAuth(req(created.key), undefined, "api")).rejects.toMatchObject({ status: 401 });
  });
});
