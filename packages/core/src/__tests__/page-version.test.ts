import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPage } from "../page";
import { listPageVersions, getPageVersionSnapshot } from "../page-version";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("page versions", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-pageversion-org";
  const userId = "test-pageversion-user";

  async function cleanup() {
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Version Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  it("lists versions newest first and fetches a snapshot's bytes", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Doc", actorUserId: userId }));

    const v1 = id("pageversion");
    const v2 = id("pageversion");
    await admin.insert(schema.pageVersion).values([
      { id: v1, pageId: page.id, snapshot: Buffer.from("v1"), authorId: userId, createdAt: new Date(Date.now() - 1000) },
      { id: v2, pageId: page.id, snapshot: Buffer.from("v2"), authorId: userId },
    ]);

    const versions = await withAuthorizedTenant(ctx, (tx) => listPageVersions(tx, page.id));
    expect(versions.map((v) => v.id)).toEqual([v2, v1]);

    const snapshot = await withAuthorizedTenant(ctx, (tx) => getPageVersionSnapshot(tx, page.id, v1));
    expect(snapshot?.toString()).toBe("v1");
  });

  it("getPageVersionSnapshot returns null for a version id that belongs to a different page", async () => {
    const ctx = { userId, organizationId: orgId };
    const pageA = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "A", actorUserId: userId }));
    const pageB = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "B", actorUserId: userId }));

    const versionId = id("pageversion");
    await admin.insert(schema.pageVersion).values({ id: versionId, pageId: pageB.id, snapshot: Buffer.from("b"), authorId: userId });

    const snapshot = await withAuthorizedTenant(ctx, (tx) => getPageVersionSnapshot(tx, pageA.id, versionId));
    expect(snapshot).toBeNull();
  });
});
