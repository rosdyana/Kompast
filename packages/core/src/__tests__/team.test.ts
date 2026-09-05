import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema, eq, and } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { requireTeamAdmin, withAuthorizedTenant, ForbiddenError } from "../permissions";
import { addTeamMember, listOrgMembersNotInTeam, listTeamMembers, listTeamsForWorkspace, removeTeamMember, setTeamMemberRole } from "../team";
import { id } from "../ids";

describe("team service layer", () => {
  const env = loadEnv();
  const admin = drizzle(postgres(env.DATABASE_ADMIN_URL, { max: 1 }));

  const orgId = "test-team-org";
  const superAdminId = "test-team-super-admin";
  const teamAdminId = "test-team-admin-user";
  const plainMemberId = "test-team-plain-member";
  const outsiderId = "test-team-outsider";
  const teamId = "test-team-a";
  const otherTeamId = "test-team-b";

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
    await admin.insert(schema.organization).values({ id: orgId, name: "Test Team Org", slug: orgId });
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
      { id: teamId, organizationId: orgId, name: "Team A", memberCount: 1 },
      { id: otherTeamId, organizationId: orgId, name: "Team B", memberCount: 0 },
    ]);
    await admin.insert(schema.teamMember).values({ id: id("tmem"), teamId, userId: teamAdminId, role: "member" });
  }

  beforeEach(resetFixtures);
  afterAll(cleanup);

  it("setTeamMemberRole promotes a member without touching team.memberCount", async () => {
    await setTeamMemberRole(db, { teamId, userId: teamAdminId, role: "admin" });

    const [row] = await admin.select().from(schema.teamMember).where(eq(schema.teamMember.userId, teamAdminId));
    expect(row?.role).toBe("admin");

    const [team] = await admin.select().from(schema.team).where(eq(schema.team.id, teamId));
    expect(team?.memberCount).toBe(1); // untouched — plugin-managed, not this function's job
  });

  it("setTeamMemberRole throws for a user not on the team", async () => {
    await expect(setTeamMemberRole(db, { teamId: otherTeamId, userId: teamAdminId, role: "admin" })).rejects.toThrow();
  });

  it("listTeamsForWorkspace reports member/project counts and the viewer's own role per team", async () => {
    await setTeamMemberRole(db, { teamId, userId: teamAdminId, role: "admin" });
    await withAuthorizedTenant({ userId: teamAdminId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "TTA", name: "Team A Project", actorUserId: teamAdminId }),
    );

    const teams = await withAuthorizedTenant({ userId: teamAdminId, organizationId: orgId }, (tx) =>
      listTeamsForWorkspace(tx, { organizationId: orgId, userId: teamAdminId }),
    );

    const teamA = teams.find((t) => t.id === teamId)!;
    const teamB = teams.find((t) => t.id === otherTeamId)!;
    expect(teamA.memberCount).toBe(1);
    expect(teamA.projectCount).toBe(1);
    expect(teamA.myRole).toBe("admin");
    expect(teamB.projectCount).toBe(0);
    expect(teamB.myRole).toBeNull();
  });

  it("a team admin can create a project in their own team but not another team", async () => {
    await setTeamMemberRole(db, { teamId, userId: teamAdminId, role: "admin" });

    const ownTeam = await withAuthorizedTenant({ userId: teamAdminId, organizationId: orgId }, async (tx) => {
      await requireTeamAdmin(tx, { userId: teamAdminId, organizationId: orgId, teamId });
      return createProject(tx, { organizationId: orgId, teamId, key: "OWN", name: "Own Team Project", actorUserId: teamAdminId });
    });
    expect(ownTeam.projectId).toBeTruthy();

    await expect(
      withAuthorizedTenant({ userId: teamAdminId, organizationId: orgId }, (tx) =>
        requireTeamAdmin(tx, { userId: teamAdminId, organizationId: orgId, teamId: otherTeamId }),
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it("the super admin can create a project in any team without an explicit team_member row", async () => {
    const result = await withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, async (tx) => {
      await requireTeamAdmin(tx, { userId: superAdminId, organizationId: orgId, teamId: otherTeamId });
      return createProject(tx, { organizationId: orgId, teamId: otherTeamId, key: "SUP", name: "Super Admin Project", actorUserId: superAdminId });
    });
    expect(result.projectId).toBeTruthy();
  });

  describe("addTeamMember / removeTeamMember", () => {
    it("adds a workspace member to a team and increments memberCount", async () => {
      await withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, (tx) =>
        addTeamMember(tx, { teamId, userId: plainMemberId, organizationId: orgId }),
      );

      const [row] = await admin
        .select()
        .from(schema.teamMember)
        .where(and(eq(schema.teamMember.teamId, teamId), eq(schema.teamMember.userId, plainMemberId)));
      expect(row).toBeTruthy();
      expect(row?.role).toBe("member"); // default

      const [team] = await admin.select().from(schema.team).where(eq(schema.team.id, teamId));
      expect(team?.memberCount).toBe(2); // was seeded at 1 (teamAdminId)
    });

    it("rejects adding a user who isn't a workspace member at all", async () => {
      await expect(
        withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, (tx) =>
          addTeamMember(tx, { teamId, userId: outsiderId, organizationId: orgId }),
        ),
      ).rejects.toThrow();
    });

    it("no-ops (doesn't double-increment memberCount) when adding an existing team member again", async () => {
      await withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, (tx) =>
        addTeamMember(tx, { teamId, userId: teamAdminId, organizationId: orgId }),
      );
      const [team] = await admin.select().from(schema.team).where(eq(schema.team.id, teamId));
      expect(team?.memberCount).toBe(1); // unchanged — teamAdminId was already seeded as a member
    });

    it("removes a member and decrements memberCount, never going negative", async () => {
      await withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, (tx) => removeTeamMember(tx, { teamId, userId: teamAdminId }));
      const [row] = await admin.select().from(schema.teamMember).where(eq(schema.teamMember.userId, teamAdminId));
      expect(row).toBeUndefined();
      const [team] = await admin.select().from(schema.team).where(eq(schema.team.id, teamId));
      expect(team?.memberCount).toBe(0);

      // removing again (already gone) must not underflow below 0
      await withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, (tx) => removeTeamMember(tx, { teamId, userId: teamAdminId }));
      const [teamAfter] = await admin.select().from(schema.team).where(eq(schema.team.id, teamId));
      expect(teamAfter?.memberCount).toBe(0);
    });

    it("listTeamMembers / listOrgMembersNotInTeam report the roster and eligible candidates", async () => {
      const members = await listTeamMembers(db, teamId);
      expect(members.map((m) => m.userId)).toEqual([teamAdminId]);

      const candidates = await withAuthorizedTenant({ userId: superAdminId, organizationId: orgId }, (tx) =>
        listOrgMembersNotInTeam(tx, { organizationId: orgId }, teamId),
      );
      expect(candidates.map((c) => c.userId).sort()).toEqual([plainMemberId, superAdminId].sort());
    });
  });

  describe("team-scoped membership management (the user's explicit ask)", () => {
    it("a team's own admin (with a plain workspace role) can manage THEIR team's membership", async () => {
      await setTeamMemberRole(db, { teamId, userId: teamAdminId, role: "admin" });

      // teamAdminId's own workspace member.role is plain "member" (never promoted) —
      // this is exactly the case that broke against Better Auth's own
      // addTeamMember/removeTeamMember before this rework.
      await withAuthorizedTenant({ userId: teamAdminId, organizationId: orgId }, async (tx) => {
        await requireTeamAdmin(tx, { userId: teamAdminId, organizationId: orgId, teamId });
        await addTeamMember(tx, { teamId, userId: plainMemberId, organizationId: orgId });
      });
      const [row] = await admin
        .select()
        .from(schema.teamMember)
        .where(and(eq(schema.teamMember.teamId, teamId), eq(schema.teamMember.userId, plainMemberId)));
      expect(row).toBeTruthy();

      const [callerMember] = await admin
        .select()
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, teamAdminId)));
      expect(callerMember?.role).toBe("member"); // unchanged — no workspace-role bleed
    });

    it("a team admin cannot manage a DIFFERENT team's membership", async () => {
      await setTeamMemberRole(db, { teamId, userId: teamAdminId, role: "admin" });
      await expect(
        withAuthorizedTenant({ userId: teamAdminId, organizationId: orgId }, (tx) =>
          requireTeamAdmin(tx, { userId: teamAdminId, organizationId: orgId, teamId: otherTeamId }),
        ),
      ).rejects.toThrow(ForbiddenError);
    });
  });
});
