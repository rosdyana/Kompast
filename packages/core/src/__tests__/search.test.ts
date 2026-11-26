import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { resolveIssueRef, searchWorkspace } from "../search";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

describe("search", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL!, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-search-org";
  const otherOrgId = "test-search-other-org";
  const userId = "test-search-user";
  const otherUserId = "test-search-other-user";
  const teamId = "test-search-team";
  const otherTeamId = "test-search-other-team";

  async function cleanup() {
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, otherOrgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, otherOrgId));
    await admin.delete(schema.member).where(eq(schema.member.userId, userId));
    await admin.delete(schema.member).where(eq(schema.member.userId, otherUserId));
    await admin.delete(schema.user).where(eq(schema.user.id, userId));
    await admin.delete(schema.user).where(eq(schema.user.id, otherUserId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await admin.delete(schema.organization).where(eq(schema.organization.id, otherOrgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values([
      { id: orgId, name: "Search Org", slug: orgId },
      { id: otherOrgId, name: "Other Org", slug: otherOrgId },
    ]);
    await admin.insert(schema.user).values([
      { id: userId, name: "Rani Adyatma", email: `${userId}@example.com` },
      { id: otherUserId, name: "Budi Santoso", email: `${otherUserId}@example.com` },
    ]);
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId, role: "member" },
      { id: id("mem"), organizationId: otherOrgId, userId: otherUserId, role: "member" },
    ]);
    await admin.insert(schema.team).values([
      { id: teamId, organizationId: orgId, name: "Test Team" },
      { id: otherTeamId, organizationId: otherOrgId, name: "Other Test Team" },
    ]);
    // Each user belongs to their own org's team, or team-scoped RLS hides the projects they create.
    await admin.insert(schema.teamMember).values([
      { id: `tmem-${teamId}`, teamId, userId, membershipKey: `${teamId}:${userId}` },
      { id: `tmem-${otherTeamId}`, teamId: otherTeamId, userId: otherUserId, membershipKey: `${otherTeamId}:${otherUserId}` },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  it("finds issues by a substring of the title, scoped to the caller's org", async () => {
    const { projectId, boardId, issueTypes, statuses } = await withAuthorizedTenant(
      { userId, organizationId: orgId },
      (tx) => createProject(tx, { organizationId: orgId, teamId, key: "srch", name: "Search Test", actorUserId: userId }),
    );
    void boardId;

    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: issueTypes[0]!.id,
        statusId: statuses[0]!.id,
        title: "Fix flaky checkout button",
        reporterId: userId,
      }),
    );

    const { projectId: otherProjectId, issueTypes: otherTypes, statuses: otherStatuses } = await withAuthorizedTenant(
      { userId: otherUserId, organizationId: otherOrgId },
      (tx) => createProject(tx, { organizationId: otherOrgId, teamId: otherTeamId, key: "othr", name: "Other Project", actorUserId: otherUserId }),
    );
    await withAuthorizedTenant({ userId: otherUserId, organizationId: otherOrgId }, (tx) =>
      createIssue(tx, {
        organizationId: otherOrgId,
        projectId: otherProjectId,
        typeId: otherTypes[0]!.id,
        statusId: otherStatuses[0]!.id,
        title: "Checkout button also broken here",
        reporterId: otherUserId,
      }),
    );

    const result = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      searchWorkspace(tx, orgId, "checkout"),
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.title).toBe("Fix flaky checkout button");
  });

  it("finds an issue by its exact key", async () => {
    const { projectId, issueTypes, statuses } = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId, key: "keyt", name: "Key Test", actorUserId: userId }),
    );
    await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: issueTypes[0]!.id,
        statusId: statuses[0]!.id,
        title: "Totally unrelated title",
        reporterId: userId,
      }),
    );

    const result = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      searchWorkspace(tx, orgId, "KEYT-1"),
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.title).toBe("Totally unrelated title");
  });

  it("finds people by name, scoped to members of the caller's org", async () => {
    const result = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) =>
      searchWorkspace(tx, orgId, "budi"),
    );
    expect(result.people).toHaveLength(0);

    const own = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => searchWorkspace(tx, orgId, "rani"));
    expect(own.people).toHaveLength(1);
    expect(own.people[0]?.name).toBe("Rani Adyatma");
  });

  it("returns nothing for a query shorter than 2 characters", async () => {
    const result = await withAuthorizedTenant({ userId, organizationId: orgId }, (tx) => searchWorkspace(tx, orgId, "a"));
    expect(result.issues).toHaveLength(0);
    expect(result.people).toHaveLength(0);
  });
  describe("resolveIssueRef", () => {
    const ctx = { userId, organizationId: orgId };

    async function projectWithIssue() {
      const { projectId, issueTypes, statuses } = await withAuthorizedTenant(ctx, (tx) =>
        createProject(tx, { organizationId: orgId, teamId, key: "rslv", name: "Resolve Test", actorUserId: userId }),
      );
      const { issueId } = await withAuthorizedTenant(ctx, (tx) =>
        createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: "Paste me", reporterId: userId }),
      );
      return { projectId, issueId };
    }

    it("resolves team + key + sequence to the issue, case-insensitively on the key", async () => {
      const { issueId } = await projectWithIssue();
      const ref = await withAuthorizedTenant(ctx, (tx) => resolveIssueRef(tx, { organizationId: orgId, teamId, projectKey: "rslv", keySeq: 1 }));
      expect(ref).toEqual({ issueId, projectKey: "RSLV", keySeq: 1, teamId, title: "Paste me" });
    });

    it("returns null for a missing sequence, the wrong team, or an archived issue", async () => {
      const { issueId } = await projectWithIssue();
      const resolve = (input: { teamId: string | null; keySeq: number }) =>
        withAuthorizedTenant(ctx, (tx) => resolveIssueRef(tx, { organizationId: orgId, projectKey: "RSLV", ...input }));
      expect(await resolve({ teamId, keySeq: 99 })).toBeNull();
      expect(await resolve({ teamId: null, keySeq: 1 })).toBeNull();
      await admin.update(schema.issue).set({ archivedAt: new Date() }).where(eq(schema.issue.id, issueId));
      expect(await resolve({ teamId, keySeq: 1 })).toBeNull();
    });

    it("returns null when the issue's project belongs to a team the caller isn't in", async () => {
      const { projectId } = await projectWithIssue();
      const hiddenTeamId = "test-search-hidden-team";
      await admin.insert(schema.team).values({ id: hiddenTeamId, organizationId: orgId, name: "Hidden Team" });
      await admin.update(schema.project).set({ teamId: hiddenTeamId }).where(eq(schema.project.id, projectId));
      const ref = await withAuthorizedTenant(ctx, (tx) => resolveIssueRef(tx, { organizationId: orgId, teamId: hiddenTeamId, projectKey: "RSLV", keySeq: 1 }));
      expect(ref).toBeNull();
    });
  });
});
