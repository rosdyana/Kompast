import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPage, archivePage, restorePage } from "../page";
import { requirePageAccess, requireCanCopyPage, requireCanManagePageAccess } from "../page-permission";
import { ForbiddenError } from "../permissions";
import { NotFoundError } from "../errors";
import { createShareLink, listShareLinks, revokeShareLink, resolveShareLink, checkSharePassword, getSharedPageContent, getSharedPageMeta } from "../share-link";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";
import { hashPassword, hashPasswordAsync, verifyPassword, verifyPasswordAsync } from "../crypto";

describe("share links", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL!, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-sharelink-org";
  const userId = "test-sharelink-user";
  const otherId = "test-sharelink-other";

  async function cleanup() {
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, otherId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Share Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.user).values({ id: otherId, name: "Other", email: `${otherId}@example.com` });
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: otherId, role: "member" },
    ]);
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
    expect(await checkSharePassword(resolved!.shareLink, "wrong")).toBe(false);
    expect(await checkSharePassword(resolved!.shareLink, "correct-horse")).toBe(true);
  });

  it("getSharedPageContent returns the page's stored Yjs bytes for a valid token", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Shared", actorUserId: userId }));
    await admin.insert(schema.ydocState).values({ pageId: page.id, state: Buffer.from("fake-yjs-bytes") });
    const { token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId }));

    const content = await getSharedPageContent(token, { viewerUserId: otherId });
    expect(content.status).toBe("ok");
    if (content.status !== "ok") return;
    expect(content.page.id).toBe(page.id);
    expect(content.ydocState?.toString()).toBe("fake-yjs-bytes");
  });

  it("getSharedPageContent refuses an invalid token or wrong password", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Shared", actorUserId: userId }));
    const { token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId, password: "right" }));

    expect((await getSharedPageContent("not-a-real-token", { viewerUserId: otherId })).status).toBe("not_found");
    expect((await getSharedPageContent(token, { password: "wrong", viewerUserId: otherId })).status).toBe("not_found");
    expect((await getSharedPageContent(token, { password: "right", viewerUserId: otherId })).status).toBe("ok");
  });

  describe("who can open a link", () => {
    it("defaults to signed-in only", async () => {
      const ctx = { userId, organizationId: orgId };
      const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Secret plan", actorUserId: userId }));
      await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId }));
      await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId, scope: "comment" }));

      const links = await withAuthorizedTenant(ctx, (tx) => listShareLinks(tx, page.id));
      expect(links.map((l) => l.access)).toEqual(["signed_in", "signed_in"]);
    });

    it("a signed-in link reveals nothing to an anonymous visitor, not even the title", async () => {
      const ctx = { userId, organizationId: orgId };
      const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Secret plan", actorUserId: userId }));
      await admin.insert(schema.ydocState).values({ pageId: page.id, state: Buffer.from("fake-yjs-bytes") });
      const { token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId }));

      const meta = await getSharedPageMeta(token, null);
      expect(meta).toEqual({ status: "login_required" });
      const content = await getSharedPageContent(token, { viewerUserId: null });
      expect(content).toEqual({ status: "login_required" });
    });

    it("a signed-in link opens for any user with a session", async () => {
      const ctx = { userId, organizationId: orgId };
      const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Secret plan", actorUserId: userId }));
      const { token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId }));

      expect(await getSharedPageMeta(token, otherId)).toEqual({ status: "ok", title: "Secret plan", icon: null, requiresPassword: false });
      expect((await getSharedPageContent(token, { viewerUserId: otherId })).status).toBe("ok");
    });

    it("checks sign-in before the password, and still checks the password after", async () => {
      const ctx = { userId, organizationId: orgId };
      const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Secret plan", actorUserId: userId }));
      const { token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId, password: "right" }));

      expect((await getSharedPageContent(token, { password: "right", viewerUserId: null })).status).toBe("login_required");
      expect((await getSharedPageContent(token, { password: "wrong", viewerUserId: otherId })).status).toBe("not_found");
      expect((await getSharedPageContent(token, { password: "right", viewerUserId: otherId })).status).toBe("ok");
    });

    it("a public link opens with no session", async () => {
      const ctx = { userId, organizationId: orgId };
      const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Release notes", actorUserId: userId }));
      const { token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId, access: "public" }));

      expect(await getSharedPageMeta(token, null)).toEqual({ status: "ok", title: "Release notes", icon: null, requiresPassword: false });
      expect((await getSharedPageContent(token, { viewerUserId: null })).status).toBe("ok");
      const links = await withAuthorizedTenant(ctx, (tx) => listShareLinks(tx, page.id));
      expect(links[0]?.access).toBe("public");
    });

    it("an unknown token is not_found whether or not the visitor is signed in", async () => {
      expect(await getSharedPageMeta("share_nope", null)).toEqual({ status: "not_found" });
      expect(await getSharedPageMeta("share_nope", otherId)).toEqual({ status: "not_found" });
    });
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
  it("a trashed page's link stops resolving, and comes back on restore", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Shared", actorUserId: userId }));
    const { token } = await withAuthorizedTenant(ctx, (tx) => createShareLink(tx, { pageId: page.id, createdBy: userId }));

    await withAuthorizedTenant(ctx, (tx) => archivePage(tx, page.id));
    expect(await resolveShareLink(token)).toBeNull();

    await withAuthorizedTenant(ctx, (tx) => restorePage(tx, page.id));
    expect((await resolveShareLink(token))?.page.id).toBe(page.id);
  });

  describe("page access gates used by every page mutation adapter", () => {
    // `userId` restricts the page to themselves; `otherId` is in the same
    // workspace space (RLS shows them the row) but is not on the access list.
    async function restrictedPage() {
      const ctx = { userId, organizationId: orgId };
      const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Restricted", actorUserId: userId }));
      await admin.insert(schema.pagePermission).values({ id: id("pperm"), pageId: page.id, subjectType: "user", subjectId: userId, role: "full" });
      return page;
    }
    const owner = { userId, organizationId: orgId };
    const outsider = { userId: otherId, organizationId: orgId };

    it("someone off a restricted page's access list can't publish it via a share link", async () => {
      const page = await restrictedPage();
      await expect(withAuthorizedTenant(outsider, (tx) => requireCanManagePageAccess(tx, page.id, outsider))).rejects.toThrow(NotFoundError);
      await expect(withAuthorizedTenant(owner, (tx) => requireCanManagePageAccess(tx, page.id, owner))).resolves.toBeUndefined();
    });

    it("a view-only grantee can see a restricted page but not copy, share, edit or delete it", async () => {
      const page = await restrictedPage();
      await admin.insert(schema.pagePermission).values({ id: id("pperm"), pageId: page.id, subjectType: "user", subjectId: otherId, role: "view" });

      await withAuthorizedTenant(outsider, async (tx) => {
        await expect(requirePageAccess(tx, page.id, outsider, "view")).resolves.toBeUndefined();
        await expect(requirePageAccess(tx, page.id, outsider, "edit")).rejects.toThrow(NotFoundError);
        await expect(requirePageAccess(tx, page.id, outsider, "full")).rejects.toThrow(NotFoundError);
      });
      await expect(withAuthorizedTenant(outsider, (tx) => requireCanCopyPage(tx, page.id, outsider))).rejects.toThrow(ForbiddenError);
      await expect(withAuthorizedTenant(outsider, (tx) => requireCanManagePageAccess(tx, page.id, outsider))).rejects.toThrow(ForbiddenError);
    });

    it("an unrestricted page stays open: anyone in its space may copy and share it", async () => {
      const page = await withAuthorizedTenant(owner, (tx) => createPage(tx, { organizationId: orgId, title: "Open", actorUserId: userId }));
      await expect(withAuthorizedTenant(outsider, (tx) => requireCanCopyPage(tx, page.id, outsider))).resolves.toBeUndefined();
      await expect(withAuthorizedTenant(outsider, (tx) => requireCanManagePageAccess(tx, page.id, outsider))).resolves.toBeUndefined();
    });
  });
});

describe("share password hashing", () => {
  it("async and sync hashes are interchangeable (same format and scrypt parameters)", async () => {
    const syncHash = hashPassword("pw-sync");
    const asyncHash = await hashPasswordAsync("pw-async");
    expect(await verifyPasswordAsync("pw-sync", syncHash)).toBe(true);
    expect(verifyPassword("pw-async", asyncHash)).toBe(true);
    expect(await verifyPasswordAsync("wrong", asyncHash)).toBe(false);
    expect(await verifyPasswordAsync("pw-async", "not-a-hash")).toBe(false);
  });
});
