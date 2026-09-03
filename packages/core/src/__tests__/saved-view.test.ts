import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { getOrCreateDefaultTableView, listSavedViews, updateSavedViewConfig, DEFAULT_TABLE_VIEW_CONFIG } from "../saved-view";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("saved views", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-view-org";
  const userId = "test-view-user";

  beforeEach(async () => {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));

    await admin.insert(schema.organization).values({ id: orgId, name: "Test View Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "Test User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await adminClient.end();
  });

  it("creates exactly one default table view per board even when called repeatedly", async () => {
    const { boardId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, key: "view1", name: "V1", actorUserId: userId }),
    );

    const first = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      getOrCreateDefaultTableView(tx, boardId, userId),
    );
    const second = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      getOrCreateDefaultTableView(tx, boardId, userId),
    );

    expect(second.id).toBe(first.id);
    expect(first.config).toEqual(DEFAULT_TABLE_VIEW_CONFIG);

    const views = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => listSavedViews(tx, boardId));
    expect(views).toHaveLength(1);
  });

  it("persists grouping/sorting changes", async () => {
    const { boardId } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, key: "view2", name: "V2", actorUserId: userId }),
    );
    const view = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      getOrCreateDefaultTableView(tx, boardId, userId),
    );

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      updateSavedViewConfig(tx, view.id, { groupBy: "assignee", sortBy: "priority", sortDir: "desc" }),
    );

    const [updated] = await admin.select().from(schema.savedView).where(eq(schema.savedView.id, view.id));
    expect(updated?.config).toEqual({ groupBy: "assignee", sortBy: "priority", sortDir: "desc" });
  });
});
