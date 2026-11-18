import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPage } from "../page";
import { canRemovePage, requireCanRemovePage } from "../page-permission";
import { ForbiddenError, withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

/**
 * Team-space docs: any team member creates them, but a plain member may
 * only trash/delete the docs they wrote (and a trash takes the sub-pages
 * along, so those must be theirs too). Team admins and the super admin may
 * remove any. Workspace docs keep the old page-role rule.
 */
describe("team doc removal (canRemovePage)", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL!, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-teamdocs-org";
  const teamId = "test-teamdocs-team";
  const authorId = "test-teamdocs-author";
  const mateId = "test-teamdocs-mate";
  const leadId = "test-teamdocs-lead";
  const superId = "test-teamdocs-super";
  const users = [authorId, mateId, leadId, superId];
  const ctxOf = (userId: string) => ({ userId, organizationId: orgId });

  async function cleanup() {
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.teamMember).where(eq(schema.teamMember.teamId, teamId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    for (const u of users) await admin.delete(schema.user).where(eq(schema.user.id, u));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Team Docs Org", slug: orgId });
    await admin.insert(schema.user).values(users.map((u) => ({ id: u, name: u, email: `${u}@example.com` })));
    await admin.insert(schema.member).values(
      users.map((u) => ({ id: id("mem"), organizationId: orgId, userId: u, role: "member", isSuperAdmin: u === superId })),
    );
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Docs Team" });
    await admin.insert(schema.teamMember).values(
      [authorId, mateId, leadId].map((u) => ({ id: `tmem-${teamId}-${u}`, teamId, userId: u, membershipKey: `${teamId}:${u}`, role: u === leadId ? "admin" : "member" })),
    );
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  const newTeamDoc = (userId: string, parentPageId?: string) =>
    withAuthorizedTenant(ctxOf(userId), (tx) => createPage(tx, { organizationId: orgId, teamId, parentPageId, title: `by ${userId}`, actorUserId: userId }));
  const can = (userId: string, pageId: string, removal: "trash" | "delete") =>
    withAuthorizedTenant(ctxOf(userId), (tx) => canRemovePage(tx, pageId, ctxOf(userId), removal));

  it("a plain member removes only their own team docs; team admin and super admin remove any", async () => {
    const doc = await newTeamDoc(authorId);
    expect(await can(authorId, doc.id, "trash")).toBe(true);
    expect(await can(authorId, doc.id, "delete")).toBe(true);
    expect(await can(mateId, doc.id, "trash")).toBe(false);
    expect(await can(mateId, doc.id, "delete")).toBe(false);
    expect(await can(leadId, doc.id, "trash")).toBe(true);
    expect(await can(superId, doc.id, "delete")).toBe(true);
    await expect(
      withAuthorizedTenant(ctxOf(mateId), (tx) => requireCanRemovePage(tx, doc.id, ctxOf(mateId), "trash")),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("an author can't trash their doc while it holds a teammate's sub-page, but can still delete it from the trash", async () => {
    const parent = await newTeamDoc(authorId);
    await newTeamDoc(mateId, parent.id);
    expect(await can(authorId, parent.id, "trash")).toBe(false);
    expect(await can(leadId, parent.id, "trash")).toBe(true);
    // permanentlyDeletePage re-parents children instead of deleting them.
    expect(await can(authorId, parent.id, "delete")).toBe(true);
  });

  it("Workspace docs keep the plain page-role rule: any member may trash an unrestricted one", async () => {
    const doc = await withAuthorizedTenant(ctxOf(authorId), (tx) => createPage(tx, { organizationId: orgId, title: "ws", actorUserId: authorId }));
    expect(await can(mateId, doc.id, "trash")).toBe(true);
  });
});
