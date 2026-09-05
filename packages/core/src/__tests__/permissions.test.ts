import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema, withTenant, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { requireProjectAdmin, requireSuperAdmin, requireTeamAdmin, transferSuperAdmin, withAuthorizedTenant, ForbiddenError } from "../permissions";
import { id } from "../ids";

/**
 * Exercises the new super-admin/team-admin gates against a live Postgres —
 * same conventions as project-and-board.test.ts (identity fixtures inserted
 * directly via an admin-connected client, not through Better Auth's HTTP
 * layer).
 */
describe("super admin / team admin permissions", () => {
  const env = loadEnv();
  const admin = drizzle(postgres(env.DATABASE_ADMIN_URL, { max: 1 }));

  const orgId = "test-perm-org";
  const superAdminId = "test-perm-super-admin";
  const teamAdminId = "test-perm-team-admin";
  const plainMemberId = "test-perm-plain-member";
  const outsiderId = "test-perm-outsider";
  const teamId = "test-perm-team";
  const otherTeamId = "test-perm-other-team";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.teamMember).where(eq(schema.teamMember.teamId, teamId));
    await admin.delete(schema.teamMember).where(eq(schema.teamMember.teamId, otherTeamId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(eq(schema.user.id, superAdminId));
    await admin.delete(schema.user).where(eq(schema.user.id, teamAdminId));
    await admin.delete(schema.user).where(eq(schema.user.id, plainMemberId));
    await admin.delete(schema.user).where(eq(schema.user.id, outsiderId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  async function resetFixtures() {
    await cleanup();

    await admin.insert(schema.organization).values({ id: orgId, name: "Test Perm Org", slug: orgId });
    await admin.insert(schema.user).values([
      { id: superAdminId, name: "Super Admin", email: `${superAdminId}@example.com` },
      { id: teamAdminId, name: "Team Admin", email: `${teamAdminId}@example.com` },
      { id: plainMemberId, name: "Plain Member", email: `${plainMemberId}@example.com` },
      { id: outsiderId, name: "Outsider", email: `${outsiderId}@example.com` },
    ]);
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: superAdminId, role: "owner", isSuperAdmin: true },
      { id: id("mem"), organizationId: orgId, userId: teamAdminId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: plainMemberId, role: "member" },
    ]);
    await admin.insert(schema.team).values([
      { id: teamId, organizationId: orgId, name: "Test Team" },
      { id: otherTeamId, organizationId: orgId, name: "Other Team" },
    ]);
    await admin.insert(schema.teamMember).values([
      { id: id("tmem"), teamId, userId: teamAdminId, role: "admin" },
      { id: id("tmem"), teamId, userId: plainMemberId, role: "member" },
    ]);
  }

  beforeEach(resetFixtures);
  afterAll(cleanup);

  describe("requireSuperAdmin", () => {
    it("passes for the workspace's super admin", async () => {
      await expect(requireSuperAdmin(db, { userId: superAdminId, organizationId: orgId })).resolves.toBeUndefined();
    });

    it("rejects a plain member, even one who is a team admin", async () => {
      await expect(requireSuperAdmin(db, { userId: teamAdminId, organizationId: orgId })).rejects.toThrow(ForbiddenError);
    });

    it("rejects someone with no membership row at all", async () => {
      await expect(requireSuperAdmin(db, { userId: outsiderId, organizationId: orgId })).rejects.toThrow(ForbiddenError);
    });
  });

  describe("requireTeamAdmin", () => {
    it("passes for the team's own admin", async () => {
      await expect(
        requireTeamAdmin(db, { userId: teamAdminId, organizationId: orgId, teamId }),
      ).resolves.toBeUndefined();
    });

    it("passes for the super admin on any team, even one they aren't a member of", async () => {
      await expect(
        requireTeamAdmin(db, { userId: superAdminId, organizationId: orgId, teamId: otherTeamId }),
      ).resolves.toBeUndefined();
    });

    it("rejects a plain (non-admin) team member", async () => {
      await expect(
        requireTeamAdmin(db, { userId: plainMemberId, organizationId: orgId, teamId }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects the team admin of a DIFFERENT team", async () => {
      await expect(
        requireTeamAdmin(db, { userId: teamAdminId, organizationId: orgId, teamId: otherTeamId }),
      ).rejects.toThrow(ForbiddenError);
    });

    it("rejects a teamId that doesn't belong to the caller's organization", async () => {
      await expect(
        requireTeamAdmin(db, { userId: superAdminId, organizationId: orgId, teamId: "not-a-real-team" }),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("transferSuperAdmin", () => {
    it("atomically moves the flag and promotes a plain member's role to admin", async () => {
      await withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, (tx) =>
        transferSuperAdmin(tx, { userId: superAdminId, organizationId: orgId }, plainMemberId),
      );

      const [oldHolder, newHolder] = await withTenant(db, { userId: plainMemberId, organizationId: orgId }, async (tx) => [
        (await tx.select().from(schema.member).where(eq(schema.member.userId, superAdminId)))[0],
        (await tx.select().from(schema.member).where(eq(schema.member.userId, plainMemberId)))[0],
      ]);

      expect(oldHolder?.isSuperAdmin).toBe(false);
      expect(newHolder?.isSuperAdmin).toBe(true);
      // Required so Better Auth's addTeamMember (member:update permission)
      // keeps working for the new holder — see transferSuperAdmin's own
      // doc comment in permissions.ts.
      expect(newHolder?.role).toBe("admin");
    });

    it("only the CURRENT super admin may call it", async () => {
      await expect(
        withAuthorizedTenant({ userId: teamAdminId, organizationId: orgId }, (tx) =>
          transferSuperAdmin(tx, { userId: teamAdminId, organizationId: orgId }, plainMemberId),
        ),
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe("requireProjectAdmin", () => {
    it("passes for the super admin, the project's owning team's admin, or a project 'lead' — rejects everyone else", async () => {
      const { projectId } = await withAuthorizedTenant({ userId: teamAdminId, organizationId: orgId }, (tx) =>
        createProject(tx, { organizationId: orgId, teamId, key: "PADM", name: "Project Admin Test", actorUserId: teamAdminId }),
      );

      // super admin: always passes
      await expect(
        withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, (tx) => requireProjectAdmin(tx, { userId: superAdminId, organizationId: orgId, projectId })),
      ).resolves.toBeUndefined();

      // the project's owning team's admin: passes
      await expect(
        withAuthorizedTenant({ userId: teamAdminId, organizationId: orgId }, (tx) => requireProjectAdmin(tx, { userId: teamAdminId, organizationId: orgId, projectId })),
      ).resolves.toBeUndefined();

      // a plain team member with no project_member "lead" row: rejected
      await expect(
        withAuthorizedTenant({ userId: plainMemberId, organizationId: orgId }, (tx) => requireProjectAdmin(tx, { userId: plainMemberId, organizationId: orgId, projectId })),
      ).rejects.toThrow(ForbiddenError);

      // give plainMemberId a project_member "lead" row directly — now passes without any team role
      await admin.insert(schema.projectMember).values({ id: id("pmem"), projectId, userId: plainMemberId, role: "lead" });
      await expect(
        withAuthorizedTenant({ userId: plainMemberId, organizationId: orgId }, (tx) => requireProjectAdmin(tx, { userId: plainMemberId, organizationId: orgId, projectId })),
      ).resolves.toBeUndefined();

      await admin.delete(schema.projectMember).where(eq(schema.projectMember.projectId, projectId));
    });

    it("rejects a projectId that doesn't exist in the caller's organization", async () => {
      await expect(
        withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, (tx) =>
          requireProjectAdmin(tx, { userId: superAdminId, organizationId: orgId, projectId: "not-a-real-project" }),
        ),
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
