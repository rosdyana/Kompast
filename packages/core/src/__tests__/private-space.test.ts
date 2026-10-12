import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, eq, inArray, sql } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { archivePage, createPage, duplicatePage, listArchivedPages, listPageTree, movePage, PageSpaceError } from "../page";
import { canAccessPage, canManagePageAccess, getPageAccess, grantPageAccess, removePagePermission } from "../page-permission";
import { listDepartedMemberPages, recoverDepartedMemberPage } from "../page-recovery";
import { createShareLink } from "../share-link";
import { canUserSeeEntity, ForbiddenError, withAuthorizedTenant } from "../permissions";
import { notify } from "../notification";
import { id } from "../ids";

/**
 * The Private space (Notion's "Private" sidebar section): a page with
 * private_owner_id set is visible to that one user only — not teammates,
 * not the workspace owner, not the super admin. Enforced by the page RLS
 * policy (packages/db/rls.sql), so every assertion below reads through the
 * real withAuthorizedTenant path; the admin connection is only used for
 * fixtures and to check what was actually written.
 */
describe("private space", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-priv-org";
  const teamId = "test-priv-team";
  const users = {
    alice: "test-priv-alice",
    bob: "test-priv-bob", // same team as alice
    superAdmin: "test-priv-super",
    owner: "test-priv-owner", // workspace owner role
    carol: "test-priv-carol", // a member in no team
    leaver: "test-priv-leaver", // leaves the workspace mid-test
  };
  const ctxOf = (userId: string) => ({ userId, organizationId: orgId });
  const asUser = <T>(userId: string, fn: Parameters<typeof withAuthorizedTenant<T>>[1]) => withAuthorizedTenant(ctxOf(userId), fn);
  /** Drizzle wraps the driver error ("Failed query: …"); the Postgres reason is on .cause. */
  const pgReason = (p: Promise<unknown>) =>
    p.then(
      () => "resolved",
      (err: Error & { cause?: Error }) => err.cause?.message ?? err.message,
    );
  const visibleIds = (userId: string) => asUser(userId, async (tx) => (await listPageTree(tx, orgId, null)).map((p) => p.id));

  async function cleanup() {
    await admin.delete(schema.notification).where(eq(schema.notification.organizationId, orgId));
    await admin.delete(schema.auditLog).where(eq(schema.auditLog.organizationId, orgId));
    await admin.delete(schema.embedding).where(eq(schema.embedding.organizationId, orgId));
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.id, Object.values(users)));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeAll(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Private Org", slug: orgId });
    await admin.insert(schema.user).values(Object.values(users).map((u) => ({ id: u, name: u, email: `${u}@example.com` })));
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: users.alice, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: users.bob, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: users.superAdmin, role: "admin", isSuperAdmin: true },
      { id: id("mem"), organizationId: orgId, userId: users.owner, role: "owner" },
      { id: id("mem"), organizationId: orgId, userId: users.carol, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: users.leaver, role: "member" },
    ]);
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Team" });
    await admin.insert(schema.teamMember).values([
      { id: "tmem-priv-a", teamId, userId: users.alice, membershipKey: `${teamId}:${users.alice}` },
      { id: "tmem-priv-b", teamId, userId: users.bob, membershipKey: `${teamId}:${users.bob}` },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  it("a private page is visible to its owner and to nobody else — super admin and workspace owner included", async () => {
    const page = await asUser(users.alice, (tx) => createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "My notes", actorUserId: users.alice }));
    expect(page.privateOwnerId).toBe(users.alice);

    expect(await visibleIds(users.alice)).toContain(page.id);
    for (const other of [users.bob, users.superAdmin, users.owner]) {
      expect(await visibleIds(other)).not.toContain(page.id);
      expect(await asUser(other, (tx) => canAccessPage(tx, page.id, ctxOf(other), "view"))).toBe(false);
      // Not just filtered from the list: a direct fetch by id finds nothing.
      expect(await asUser(other, (tx) => tx.select().from(schema.page).where(eq(schema.page.id, page.id)))).toHaveLength(0);
    }
    expect(await asUser(users.alice, (tx) => canAccessPage(tx, page.id, ctxOf(users.alice), "full"))).toBe(true);
  });

  it("sub-pages inherit the private space, and a different space under a private parent is refused", async () => {
    const parent = await asUser(users.alice, (tx) => createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Parent", actorUserId: users.alice }));
    const child = await asUser(users.alice, (tx) => createPage(tx, { organizationId: orgId, parentPageId: parent.id, title: "Child", actorUserId: users.alice }));
    expect(child.privateOwnerId).toBe(users.alice);

    await expect(
      asUser(users.alice, (tx) => createPage(tx, { organizationId: orgId, parentPageId: parent.id, teamId, title: "Leak", actorUserId: users.alice })),
    ).rejects.toThrow(PageSpaceError);
    await expect(
      asUser(users.alice, (tx) => createPage(tx, { organizationId: orgId, teamId, privateOwnerId: users.alice, title: "Both", actorUserId: users.alice })),
    ).rejects.toThrow(PageSpaceError);
  });

  it("nobody can create or move a page into someone else's private space (RLS WITH CHECK)", async () => {
    expect(
      await pgReason(asUser(users.bob, (tx) => createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Planted", actorUserId: users.bob }))),
    ).toMatch(/row-level security/);

    const bobs = await asUser(users.bob, (tx) => createPage(tx, { organizationId: orgId, title: "Bob's workspace page", actorUserId: users.bob }));
    expect(await pgReason(asUser(users.bob, (tx) => movePage(tx, bobs.id, { parentPageId: null, space: { privateOwnerId: users.alice } })))).toMatch(
      /row-level security/,
    );
    // Not even the super admin can.
    expect(
      await pgReason(asUser(users.superAdmin, (tx) => createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Planted", actorUserId: users.superAdmin }))),
    ).toMatch(/row-level security/);
  });

  it("the database itself refuses a page in two spaces at once", async () => {
    expect(
      await pgReason(admin.insert(schema.page).values({ id: id("page"), organizationId: orgId, teamId, privateOwnerId: users.alice, title: "x", rank: "a0" })),
    ).toMatch(/page_single_space_ck/);
  });

  it("moving a shared page into Private takes it — and its subtree — away from everyone else, grants and live guest links included", async () => {
    const { root, sub, linkId } = await asUser(users.alice, async (tx) => {
      const root = await createPage(tx, { organizationId: orgId, teamId, title: "Team plan", actorUserId: users.alice });
      const sub = await createPage(tx, { organizationId: orgId, parentPageId: root.id, title: "Team plan / details", actorUserId: users.alice });
      await grantPageAccess(tx, { pageId: root.id, subject: { type: "user", id: users.bob }, role: "edit", actorUserId: users.alice });
      const link = await createShareLink(tx, { pageId: sub.id, createdBy: users.alice });
      return { root, sub, linkId: link.id };
    });
    expect(await visibleIds(users.bob)).toEqual(expect.arrayContaining([root.id, sub.id]));

    await asUser(users.alice, (tx) => movePage(tx, root.id, { parentPageId: null, space: { privateOwnerId: users.alice } }));

    expect(await visibleIds(users.alice)).toEqual(expect.arrayContaining([root.id, sub.id]));
    expect(await visibleIds(users.bob)).not.toContain(root.id);
    expect(await visibleIds(users.bob)).not.toContain(sub.id);
    expect(await admin.select().from(schema.pagePermission).where(eq(schema.pagePermission.pageId, root.id))).toHaveLength(0);
    const [link] = await admin.select().from(schema.shareLink).where(eq(schema.shareLink.id, linkId));
    expect(link!.revokedAt).not.toBeNull();

    // Moving it back out makes it visible again — to the whole space, since the old grants are gone.
    await asUser(users.alice, (tx) => movePage(tx, root.id, { parentPageId: null, space: { teamId } }));
    expect(await visibleIds(users.bob)).toEqual(expect.arrayContaining([root.id, sub.id]));
    expect(await asUser(users.bob, (tx) => canAccessPage(tx, root.id, ctxOf(users.bob), "edit"))).toBe(true);
  });

  describe("Shared (Notion's sidebar section)", () => {
    it("inviting people shares the whole tree with exactly them, at their role, and notifies them", async () => {
      const { root, child } = await asUser(users.alice, async (tx) => {
        const root = await createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "1:1 notes", actorUserId: users.alice });
        const child = await createPage(tx, { organizationId: orgId, parentPageId: root.id, title: "Week 1", actorUserId: users.alice });
        await grantPageAccess(tx, { pageId: root.id, subject: { type: "user", id: users.bob }, role: "edit", actorUserId: users.alice });
        // Sharing from a sub-page shares the tree (the grant lands on the root).
        await grantPageAccess(tx, { pageId: child.id, subject: { type: "user", id: users.carol }, role: "view", actorUserId: users.alice });
        return { root, child };
      });

      for (const invitee of [users.bob, users.carol]) {
        expect(await visibleIds(invitee)).toEqual(expect.arrayContaining([root.id, child.id]));
      }
      for (const outsider of [users.superAdmin, users.owner]) {
        expect(await visibleIds(outsider)).not.toContain(root.id);
      }
      const role = (userId: string, pageId: string, min: "view" | "edit" | "full") => asUser(userId, (tx) => canAccessPage(tx, pageId, ctxOf(userId), min));
      expect(await role(users.bob, child.id, "edit")).toBe(true);
      expect(await role(users.bob, child.id, "full")).toBe(false);
      expect(await role(users.carol, child.id, "view")).toBe(true);
      expect(await role(users.carol, child.id, "edit")).toBe(false);
      expect(await asUser(users.bob, (tx) => canManagePageAccess(tx, root.id, ctxOf(users.bob)))).toBe(false);

      const access = await asUser(users.alice, (tx) => getPageAccess(tx, child.id, ctxOf(users.alice)));
      expect(access.owner?.id).toBe(users.alice);
      expect(access.grants.map((g) => [g.subjectId, g.role]).sort()).toEqual([[users.bob, "edit"], [users.carol, "view"]]);
      expect(access.candidates.users.map((u) => u.id)).not.toContain(users.alice);
      expect(access.candidates.teams).toEqual([]);

      const notes = await admin.select().from(schema.notification).where(eq(schema.notification.entityId, root.id));
      expect(notes.map((n) => [n.userId, n.eventType]).sort()).toEqual([[users.bob, "page.shared"], [users.carol, "page.shared"]]);

      // A page an invitee adds inside the tree is shared the same way.
      const bobsChild = await asUser(users.bob, (tx) => createPage(tx, { organizationId: orgId, parentPageId: root.id, title: "Bob's agenda", actorUserId: users.bob }));
      expect(await visibleIds(users.carol)).toContain(bobsChild.id);
      expect(await visibleIds(users.alice)).toContain(bobsChild.id);
    });

    it("refuses teams, non-members, the owner, and removing yourself", async () => {
      const page = await asUser(users.alice, (tx) => createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Plans", actorUserId: users.alice }));
      const grant = (subject: { type: "user" | "team"; id: string }) =>
        asUser(users.alice, (tx) => grantPageAccess(tx, { pageId: page.id, subject, role: "view", actorUserId: users.alice }));
      await expect(grant({ type: "team", id: teamId })).rejects.toThrow(PageSpaceError);
      await expect(grant({ type: "user", id: "test-priv-nobody" })).rejects.toThrow(PageSpaceError);
      await expect(grant({ type: "user", id: users.alice })).rejects.toThrow(PageSpaceError);

      await asUser(users.alice, (tx) => grantPageAccess(tx, { pageId: page.id, subject: { type: "user", id: users.bob }, role: "full", actorUserId: users.alice }));
      await expect(asUser(users.bob, (tx) => removePagePermission(tx, page.id, { type: "user", id: users.bob }, users.bob))).rejects.toThrow(PageSpaceError);
    });

    it("un-inviting everyone turns it back into a Private page", async () => {
      const page = await asUser(users.alice, async (tx) => {
        const page = await createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Draft", actorUserId: users.alice });
        await grantPageAccess(tx, { pageId: page.id, subject: { type: "user", id: users.bob }, role: "view", actorUserId: users.alice });
        return page;
      });
      expect(await visibleIds(users.bob)).toContain(page.id);
      await asUser(users.alice, (tx) => removePagePermission(tx, page.id, { type: "user", id: users.bob }, users.alice));
      expect(await visibleIds(users.bob)).not.toContain(page.id);
      const [row] = await admin.select().from(schema.page).where(eq(schema.page.id, page.id));
      expect(row!.sharedWith).toEqual([]);
    });

    it("moving a Shared tree to the Workspace drops the invitations instead of locking the owner out", async () => {
      const page = await asUser(users.alice, async (tx) => {
        const page = await createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Proposal", actorUserId: users.alice });
        await grantPageAccess(tx, { pageId: page.id, subject: { type: "user", id: users.bob }, role: "view", actorUserId: users.alice });
        await movePage(tx, page.id, { parentPageId: null, space: {} });
        return page;
      });
      expect(await admin.select().from(schema.pagePermission).where(eq(schema.pagePermission.pageId, page.id))).toHaveLength(0);
      expect(await asUser(users.alice, (tx) => canAccessPage(tx, page.id, ctxOf(users.alice), "full"))).toBe(true);
      expect(await visibleIds(users.carol)).toContain(page.id);
    });

    it("a sub-page pulled to the top of the Shared space keeps everyone's role", async () => {
      const { child } = await asUser(users.alice, async (tx) => {
        const root = await createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Root", actorUserId: users.alice });
        const child = await createPage(tx, { organizationId: orgId, parentPageId: root.id, title: "Child", actorUserId: users.alice });
        await grantPageAccess(tx, { pageId: root.id, subject: { type: "user", id: users.bob }, role: "edit", actorUserId: users.alice });
        await movePage(tx, child.id, { parentPageId: null });
        return { child };
      });
      expect(await asUser(users.bob, (tx) => canAccessPage(tx, child.id, ctxOf(users.bob), "edit"))).toBe(true);
    });

    it("an invitee's duplicate lands in their own Private space", async () => {
      const page = await asUser(users.alice, async (tx) => {
        const page = await createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Shared doc", actorUserId: users.alice });
        await grantPageAccess(tx, { pageId: page.id, subject: { type: "user", id: users.bob }, role: "view", actorUserId: users.alice });
        return page;
      });
      const copy = await asUser(users.bob, (tx) => duplicatePage(tx, page.id, { actorUserId: users.bob }));
      expect(copy).toMatchObject({ privateOwnerId: users.bob, sharedWith: [] });
      expect(await visibleIds(users.alice)).not.toContain(copy.id);
    });
  });

  it("a departed member's private pages are recoverable by the super admin, and only once they've left", async () => {
    const { notes, shared, sharedChild } = await asUser(users.leaver, async (tx) => {
      const notes = await createPage(tx, { organizationId: orgId, privateOwnerId: users.leaver, title: "Leaver notes", actorUserId: users.leaver });
      await createPage(tx, { organizationId: orgId, parentPageId: notes.id, title: "Leaver sub-notes", actorUserId: users.leaver });
      const shared = await createPage(tx, { organizationId: orgId, privateOwnerId: users.leaver, title: "Handover", actorUserId: users.leaver });
      const sharedChild = await createPage(tx, { organizationId: orgId, parentPageId: shared.id, title: "Handover / access", actorUserId: users.leaver });
      await grantPageAccess(tx, { pageId: shared.id, subject: { type: "user", id: users.bob }, role: "edit", actorUserId: users.leaver });
      return { notes, shared, sharedChild };
    });
    const departed = () => asUser(users.superAdmin, (tx) => listDepartedMemberPages(tx, ctxOf(users.superAdmin)));

    // While they're still a member, the super admin sees nothing of it.
    expect(await visibleIds(users.superAdmin)).not.toContain(notes.id);
    expect((await departed()).map((t) => t.rootId)).not.toContain(notes.id);

    await admin.delete(schema.member).where(eq(schema.member.userId, users.leaver));

    const trees = (await departed()).filter((t) => t.owner.id === users.leaver);
    expect(trees.map((t) => [t.title, t.pageCount, t.sharedWithCount]).sort()).toEqual([
      ["Handover", 2, 1],
      ["Leaver notes", 2, 0],
    ]);
    // Only the super admin: not the workspace owner, not an invitee.
    await expect(asUser(users.owner, (tx) => listDepartedMemberPages(tx, ctxOf(users.owner)))).rejects.toThrow(ForbiddenError);
    expect(await visibleIds(users.owner)).not.toContain(notes.id);
    // The invitee keeps access until it's recovered.
    expect(await visibleIds(users.bob)).toContain(shared.id);
    await expect(
      asUser(users.superAdmin, (tx) => recoverDepartedMemberPage(tx, ctxOf(users.superAdmin), { pageId: sharedChild.id, to: "me" })),
    ).rejects.toThrow(PageSpaceError);

    // Take ownership of the shared tree: stays shared with Bob, now owned by the super admin.
    await asUser(users.superAdmin, (tx) => recoverDepartedMemberPage(tx, ctxOf(users.superAdmin), { pageId: shared.id, to: "me" }));
    const [taken] = await admin.select().from(schema.page).where(eq(schema.page.id, sharedChild.id));
    expect(taken).toMatchObject({ privateOwnerId: users.superAdmin, sharedWith: [users.bob] });
    expect(await asUser(users.bob, (tx) => canAccessPage(tx, sharedChild.id, ctxOf(users.bob), "edit"))).toBe(true);

    // Move the private notes to the Workspace: now everyone sees the tree.
    await asUser(users.superAdmin, (tx) => recoverDepartedMemberPage(tx, ctxOf(users.superAdmin), { pageId: notes.id, to: "workspace" }));
    expect(await visibleIds(users.carol)).toContain(notes.id);
    expect((await departed()).filter((t) => t.owner.id === users.leaver)).toEqual([]);

    const audit = await admin.select().from(schema.auditLog).where(eq(schema.auditLog.organizationId, orgId));
    expect(audit.map((a) => [a.action, a.entityId, a.actorId]).sort()).toEqual(
      [
        ["page.recovered_to_self", shared.id, users.superAdmin],
        ["page.recovered_to_workspace", notes.id, users.superAdmin],
      ].sort(),
    );
  });

  it("other users are never notified about a private page, super admin included", async () => {
    const page = await asUser(users.alice, (tx) => createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Mentions", actorUserId: users.alice }));
    await asUser(users.alice, async (tx) => {
      expect(await canUserSeeEntity(tx, { organizationId: orgId, userId: users.superAdmin, entityType: "page", entityId: page.id })).toBe(false);
      expect(await canUserSeeEntity(tx, { organizationId: orgId, userId: users.alice, entityType: "page", entityId: page.id })).toBe(true);
      await notify(tx, { organizationId: orgId, userId: users.bob, eventType: "page.mentioned", entityType: "page", entityId: page.id, title: "t" });
      await notify(tx, { organizationId: orgId, userId: users.superAdmin, eventType: "page.mentioned", entityType: "page", entityId: page.id, title: "t" });
    });
    expect(await admin.select().from(schema.notification).where(eq(schema.notification.entityId, page.id))).toHaveLength(0);
  });

  it("Ask Kompast can't retrieve another user's private text (embedding RLS follows the page)", async () => {
    const page = await asUser(users.alice, (tx) => createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Salary notes", actorUserId: users.alice }));
    // Indexing runs on the admin connection in apps/worker; simulate its write.
    await admin.insert(schema.embedding).values({
      id: id("emb"),
      organizationId: orgId,
      entityType: "page",
      entityId: page.id,
      chunkIndex: 0,
      content: "confidential",
      vector: sql`array_fill(0, array[1536])::vector` as unknown as number[],
    });
    const seen = (userId: string) => asUser(userId, (tx) => tx.select().from(schema.embedding).where(eq(schema.embedding.entityId, page.id)));
    expect(await seen(users.alice)).toHaveLength(1);
    expect(await seen(users.bob)).toHaveLength(0);
    expect(await seen(users.superAdmin)).toHaveLength(0);
  });

  it("duplicates stay private, and a private page in the trash is only in its owner's trash", async () => {
    const page = await asUser(users.alice, (tx) => createPage(tx, { organizationId: orgId, privateOwnerId: users.alice, title: "Draft", actorUserId: users.alice }));
    const copy = await asUser(users.alice, (tx) => duplicatePage(tx, page.id, { actorUserId: users.alice }));
    expect(copy.privateOwnerId).toBe(users.alice);

    await asUser(users.alice, (tx) => archivePage(tx, page.id));
    expect((await asUser(users.alice, (tx) => listArchivedPages(tx, orgId))).map((p) => p.id)).toContain(page.id);
    expect((await asUser(users.superAdmin, (tx) => listArchivedPages(tx, orgId))).map((p) => p.id)).not.toContain(page.id);
  });
});
