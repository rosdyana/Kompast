import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { requireTeamAdmin, withAuthorizedTenant, ForbiddenError } from "../permissions";
import { listTeamsForWorkspace, setTeamMemberRole } from "../team";
import { id } from "../ids";

describe("team service layer", () => {
  const env = loadEnv();
  const admin = drizzle(postgres(env.DATABASE_ADMIN_URL, { max: 1 }));

  const orgId = "test-team-org";
  const superAdminId = "test-team-super-admin";
  const teamAdminId = "test-team-admin-user";
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
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  async function resetFixtures() {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Test Team Org", slug: orgId });
    await admin.insert(schema.user).values([
      { id: superAdminId, name: "Super Admin", email: `${superAdminId}@example.com` },
      { id: teamAdminId, name: "Team Admin", email: `${teamAdminId}@example.com` },
    ]);
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: superAdminId, role: "owner", isSuperAdmin: true },
      { id: id("mem"), organizationId: orgId, userId: teamAdminId, role: "member" },
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
});
