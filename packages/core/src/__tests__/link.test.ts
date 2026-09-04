import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPage } from "../page";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { linkEntities, unlinkEntities, listOutgoingLinks, listBacklinks, syncPageMentions } from "../link";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("links", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-link-org";
  const userId = "test-link-user";

  async function cleanup() {
    await admin.delete(schema.link).where(eq(schema.link.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Link Org", slug: orgId });
    await admin.insert(schema.user).values({ id: userId, name: "User", email: `${userId}@example.com` });
    await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId, role: "member" });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  it("links a doc to an issue and finds it from both sides", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Design doc", actorUserId: userId }));
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
      createProject(tx, { organizationId: orgId, key: "link", name: "Link Test", actorUserId: userId }),
    );
    const issue = await withAuthorizedTenant(ctx, (tx) =>
      createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Ship it", reporterId: userId }),
    );

    await withAuthorizedTenant(ctx, (tx) =>
      linkEntities(tx, { organizationId: orgId, fromType: "page", fromId: page.id, toType: "issue", toId: issue.issueId, createdBy: userId }),
    );

    const outgoing = await withAuthorizedTenant(ctx, (tx) => listOutgoingLinks(tx, "page", page.id));
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]?.toId).toBe(issue.issueId);

    const backlinks = await withAuthorizedTenant(ctx, (tx) => listBacklinks(tx, "issue", issue.issueId));
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]?.fromId).toBe(page.id);
  });

  it("linking the same pair twice is a no-op, not a duplicate row", async () => {
    const ctx = { userId, organizationId: orgId };
    const a = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "A", actorUserId: userId }));
    const b = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "B", actorUserId: userId }));

    await withAuthorizedTenant(ctx, (tx) => linkEntities(tx, { organizationId: orgId, fromType: "page", fromId: a.id, toType: "page", toId: b.id }));
    await withAuthorizedTenant(ctx, (tx) => linkEntities(tx, { organizationId: orgId, fromType: "page", fromId: a.id, toType: "page", toId: b.id }));

    const links = await withAuthorizedTenant(ctx, (tx) => listOutgoingLinks(tx, "page", a.id));
    expect(links).toHaveLength(1);
  });

  it("unlinkEntities removes the row", async () => {
    const ctx = { userId, organizationId: orgId };
    const a = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "A", actorUserId: userId }));
    const b = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "B", actorUserId: userId }));

    await withAuthorizedTenant(ctx, (tx) => linkEntities(tx, { organizationId: orgId, fromType: "page", fromId: a.id, toType: "page", toId: b.id }));
    await withAuthorizedTenant(ctx, (tx) => unlinkEntities(tx, { fromType: "page", fromId: a.id, toType: "page", toId: b.id }));

    const links = await withAuthorizedTenant(ctx, (tx) => listOutgoingLinks(tx, "page", a.id));
    expect(links).toHaveLength(0);
  });

  it("syncPageMentions adds new mentions and removes ones no longer present", async () => {
    const ctx = { userId, organizationId: orgId };
    const page = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "Doc", actorUserId: userId }));
    const p1 = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "P1", actorUserId: userId }));
    const p2 = await withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title: "P2", actorUserId: userId }));

    await withAuthorizedTenant(ctx, (tx) => syncPageMentions(tx, orgId, page.id, [{ type: "page", id: p1.id }]));
    let backlinksP1 = await withAuthorizedTenant(ctx, (tx) => listBacklinks(tx, "page", p1.id));
    expect(backlinksP1).toHaveLength(1);

    await withAuthorizedTenant(ctx, (tx) => syncPageMentions(tx, orgId, page.id, [{ type: "page", id: p2.id }]));
    backlinksP1 = await withAuthorizedTenant(ctx, (tx) => listBacklinks(tx, "page", p1.id));
    const backlinksP2 = await withAuthorizedTenant(ctx, (tx) => listBacklinks(tx, "page", p2.id));
    expect(backlinksP1).toHaveLength(0);
    expect(backlinksP2).toHaveLength(1);
  });
});
