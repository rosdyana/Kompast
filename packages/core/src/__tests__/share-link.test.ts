import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPage } from "../page";
import { createShareLink, listShareLinks, revokeShareLink, resolveShareLink, checkSharePassword } from "../share-link";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("share links", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-sharelink-org";
  const userId = "test-sharelink-user";

  async function cleanup() {
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Share Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  it("resolves a valid token to its page with no workspace context needed", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Shared", actorUserId: userId }));
    const { token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId }));

    const resolved = await resolveShareLink(token);
    expect(resolved?.page.id).toBe(page.id);
  });

  it("rejects an unknown token", async () => {
    const resolved = await resolveShareLink("share_does-not-exist");
    expect(resolved).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Shared", actorUserId: userId }));
    const { id: shareLinkId, token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId }));

    await withAuthorizedTenant(ctx, (tx) => revokeShareLink(tx, shareLinkId));

    const resolved = await resolveShareLink(token);
    expect(resolved).toBeNull();
  });

  it("rejects an expired token", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Shared", actorUserId: userId }));
    const { token } = await withAuthorizedTenant(ctx, (tx) =>
      createShareLink(tx, { pageId: page.id, createdBy: userId, expiresAt: new Date(Date.now() - 1000) }),
    );

    const resolved = await resolveShareLink(token);
    expect(resolved).toBeNull();
  });

  it("password-protected links reject the wrong password and accept the right one", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Shared", actorUserId: userId }));
    const { token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId, password: "correct-horse" }));

    const resolved = await resolveShareLink(token);
    expect(resolved).not.toBeNull();
    expect(checkSharePassword(resolved!.shareLink, "wrong")).toBe(false);
    expect(checkSharePassword(resolved!.shareLink, "correct-horse")).toBe(true);
  });

  it("listShareLinks never exposes tokenHash or passwordHash", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Shared", actorUserId: userId }));
    await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId, password: "secret" }));

    const links = await withAuthorizedTenant(ctx, (tx) => listShareLinks(tx, page.id));
    expect(links).toHaveLength(1);
    expect(links[0]).not.toHaveProperty("tokenHash");
    expect(links[0]).not.toHaveProperty("passwordHash");
    expect(links[0]?.hasPassword).toBe(true);
  });
});
