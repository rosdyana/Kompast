import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  createPage,
  listPageTree,
  movePage,
  archivePage,
  restorePage,
  duplicatePage,
  updatePageMeta,
} from "../page";
import { canAccessPage, setPagePermission, filterAccessiblePages } from "../page-permission";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("pages", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-page-org";
  const ownerId = "test-page-owner";
  const otherId = "test-page-other";

  async function cleanup() {
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, ownerId));
    await admin.delete(schema.user).where(eq(schema.user.id, otherId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Page Org", slug: orgId });
    await admin.insert(schema.user).values([
      { id: ownerId, name: "Owner", email: `${ownerId}@example.com` },
      { id: otherId, name: "Other", email: `${otherId}@example.com` },
    ]);
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: ownerId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: otherId, role: "member" },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  it("creates workspace-level pages ordered by rank and lists them as a flat tree", async () => {
    const ctx = { userId: ownerId, organizationId: orgId };
    const a = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "A", actorUserId: ownerId }));
    const b = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "B", actorUserId: ownerId }));

    const tree = await withAuthorizedTenant(ctx, (tx) => listPageTree(tx, orgId));
    expect(tree.map((p) => p.title)).toEqual(["A", "B"]);
    expect(a.rank < b.rank).toBe(true);
  });

  it("archived pages drop out of listPageTree until restored", async () => {
    const ctx = { userId: ownerId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Temp", actorUserId: ownerId }));

    await withAuthorizedTenant(ctx, (tx) => archivePage(tx, page.id));
    let tree = await withAuthorizedTenant(ctx, (tx) => listPageTree(tx, orgId));
    expect(tree.find((p) => p.id === page.id)).toBeUndefined();

    await withAuthorizedTenant(ctx, (tx) => restorePage(tx, page.id));
    tree = await withAuthorizedTenant(ctx, (tx) => listPageTree(tx, orgId));
    expect(tree.find((p) => p.id === page.id)).toBeDefined();
  });

  it("moves a page between siblings by rank", async () => {
    const ctx = { userId: ownerId, organizationId: orgId };
    const a = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "A", actorUserId: ownerId }));
    const b = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "B", actorUserId: ownerId }));
    const c = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "C", actorUserId: ownerId }));

    // Move C between A and B.
    await withAuthorizedTenant(ctx, (tx) => movePage(tx, c.id, { parentPageId: null, afterId: a.id, beforeId: b.id }));

    const tree = await withAuthorizedTenant(ctx, (tx) => listPageTree(tx, orgId));
    expect(tree.map((p) => p.title)).toEqual(["A", "C", "B"]);
  });

  it("updates title/icon in place", async () => {
    const ctx = { userId: ownerId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Old", actorUserId: ownerId }));
    await withAuthorizedTenant(ctx, (tx) => updatePageMeta(tx, page.id, { title: "New", icon: "📄" }));

    const [updated] = await admin.select().from(schema.page).where(eq(schema.page.id, page.id));
    expect(updated?.title).toBe("New");
    expect(updated?.icon).toBe("📄");
  });

  it("duplicatePage copies the row and any synced Yjs content", async () => {
    const ctx = { userId: ownerId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Source", actorUserId: ownerId }));
    await admin.insert(schema.ydocState).values({ pageId: page.id, state: Buffer.from("fake-yjs-state") });

    const copy = await withAuthorizedTenant(ctx, (tx) => duplicatePage(tx, page.id, { actorUserId: ownerId, titleSuffix: " (copy)" }));
    expect(copy.title).toBe("Source (copy)");

    const [state] = await admin.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, copy.id));
    expect(state?.state.toString()).toBe("fake-yjs-state");
  });

  it("a page with no permission rows is open to any org member", async () => {
    const ctx = { userId: ownerId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Open", actorUserId: ownerId }));

    const access = await withAuthorizedTenant({ userId: otherId, organizationId: orgId }, (tx) =>
      canAccessPage(tx, page.id, { userId: otherId, organizationId: orgId }),
    );
    expect(access).toBe(true);
  });

  it("a page with an explicit grant is closed to everyone else", async () => {
    const ctx = { userId: ownerId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Restricted", actorUserId: ownerId }));
    await withAuthorizedTenant(ctx, (tx) => setPagePermission(tx, page.id, { type: "user", id: ownerId }, "full"));

    const ownerAccess = await withAuthorizedTenant(ctx, (tx) => canAccessPage(tx, page.id, { userId: ownerId, organizationId: orgId }));
    expect(ownerAccess).toBe(true);

    const otherAccess = await withAuthorizedTenant({ userId: otherId, organizationId: orgId }, (tx) =>
      canAccessPage(tx, page.id, { userId: otherId, organizationId: orgId }),
    );
    expect(otherAccess).toBe(false);
  });

  it("filterAccessiblePages drops only the restricted pages the caller cannot see", async () => {
    const ctx = { userId: ownerId, organizationId: orgId };
    const open = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Open", actorUserId: ownerId }));
    const restricted = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Restricted", actorUserId: ownerId }));
    await withAuthorizedTenant(ctx, (tx) => setPagePermission(tx, restricted.id, { type: "user", id: ownerId }, "full"));

    const visible = await withAuthorizedTenant({ userId: otherId, organizationId: orgId }, (tx) =>
      filterAccessiblePages(tx, [open, restricted], { userId: otherId, organizationId: orgId }),
    );
    expect(visible.map((p) => p.id)).toEqual([open.id]);
  });
});
