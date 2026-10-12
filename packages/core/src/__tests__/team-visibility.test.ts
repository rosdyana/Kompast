import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, eq, inArray, sql, adminDb } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { assignProjectToTeam, createProject, ProjectKeyConflictError } from "../project";
import { notify } from "../notification";
import { applyAcceptedTeamInvitation, listAssignableUsers, cancelTeamInvitation, createTeamInvitation, listTeamInvitations, listTeamsForWorkspace, TeamInvitationError } from "../team";
import { createIssue } from "../issue";
import { addComment } from "../comment";
import { createSprint } from "../sprint";
import { createPage, movePage, PageSpaceError } from "../page";
import { canAccessPage, setPagePermission } from "../page-permission";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

/**
 * Team-scoped visibility (packages/db/rls.sql, "Team-scoped visibility"):
 * on top of workspace isolation, project-owned content is visible only to
 * the super admin or the owning team's members, and pages follow their
 * space (project / team / Workspace). Everything here reads through the
 * real RLS-scoped withAuthorizedTenant path — the property under test is
 * exactly what the database hides, so no assertion bypasses it.
 */
describe("team-scoped visibility", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-vis-org";
  const teamA = "test-vis-team-a";
  const teamB = "test-vis-team-b";
  const users = {
    superAdmin: "test-vis-super",
    owner: "test-vis-owner", // workspace owner, NOT super admin — D2: sees only their own teams
    alice: "test-vis-alice", // team A
    bob: "test-vis-bob", // team B
    loner: "test-vis-loner", // in no team at all
  };
  const ctxOf = (userId: string) => ({ userId, organizationId: orgId });

  const fx = {} as {
    projectA: string;
    projectB: string;
    projectUnassigned: string;
    issueA: string;
    issueB: string;
    commentA: string;
    commentB: string;
    sprintA: string;
    sprintB: string;
    pageProjectA: string;
    pageTeamB: string;
    pageWorkspace: string;
    pageRestricted: string;
  };

  async function cleanup() {
    await admin.delete(schema.notification).where(eq(schema.notification.organizationId, orgId));
    await admin.delete(schema.invitation).where(eq(schema.invitation.organizationId, orgId));
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.id, Object.values(users)));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeAll(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Visibility Org", slug: orgId });
    await admin.insert(schema.user).values(Object.values(users).map((u) => ({ id: u, name: u, email: `${u}@example.com` })));
    await admin.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: users.superAdmin, role: "admin", isSuperAdmin: true },
      { id: id("mem"), organizationId: orgId, userId: users.owner, role: "owner" },
      { id: id("mem"), organizationId: orgId, userId: users.alice, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: users.bob, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: users.loner, role: "member" },
    ]);
    await admin.insert(schema.team).values([
      { id: teamA, organizationId: orgId, name: "Team A" },
      { id: teamB, organizationId: orgId, name: "Team B" },
    ]);
    await admin.insert(schema.teamMember).values([
      { id: "tmem-vis-a", teamId: teamA, userId: users.alice, membershipKey: `${teamA}:${users.alice}`, role: "admin" },
      { id: "tmem-vis-b", teamId: teamB, userId: users.bob, membershipKey: `${teamB}:${users.bob}`, role: "admin" },
    ]);

    // Each team's content is created by its own member, through the normal
    // path — which itself proves a team member can write into their team.
    const seedTeam = (userId: string, teamId: string, key: string) =>
      withAuthorizedTenant(ctxOf(userId), async (tx) => {
        const { projectId, boardId, issueTypes, statuses } = await createProject(tx, { organizationId: orgId, teamId, key, name: key, actorUserId: userId });
        const { issueId } = await createIssue(tx, { organizationId: orgId, projectId, typeId: issueTypes[0]!.id, statusId: statuses[0]!.id, title: `${key} issue`, reporterId: userId });
        const { commentId } = await addComment(tx, { issueId, authorId: userId, bodyJson: { text: `${key} comment` } });
        const sprint = await createSprint(tx, { organizationId: orgId, boardId });
        return { projectId, issueId, commentId, sprintId: sprint.sprintId };
      });
    const a = await seedTeam(users.alice, teamA, "VISA");
    const b = await seedTeam(users.bob, teamB, "VISB");
    Object.assign(fx, { projectA: a.projectId, issueA: a.issueId, commentA: a.commentId, sprintA: a.sprintId });
    Object.assign(fx, { projectB: b.projectId, issueB: b.issueId, commentB: b.commentId, sprintB: b.sprintId });

    // A legacy, team-less project — only creatable by bypassing core, the
    // same way such rows came to exist (before teams were required).
    fx.projectUnassigned = id("proj");
    await admin.insert(schema.project).values({ id: fx.projectUnassigned, organizationId: orgId, teamId: null, key: "VISU", name: "Unassigned" });

    fx.pageProjectA = (await withAuthorizedTenant(ctxOf(users.alice), (tx) => createPage(tx, { organizationId: orgId, projectId: fx.projectA, title: "A project doc", actorUserId: users.alice }))).id;
    fx.pageTeamB = (await withAuthorizedTenant(ctxOf(users.bob), (tx) => createPage(tx, { organizationId: orgId, teamId: teamB, title: "B team doc", actorUserId: users.bob }))).id;
    fx.pageWorkspace = (await withAuthorizedTenant(ctxOf(users.loner), (tx) => createPage(tx, { organizationId: orgId, title: "Handbook", actorUserId: users.loner }))).id;
    fx.pageRestricted = await withAuthorizedTenant(ctxOf(users.alice), async (tx) => {
      const page = await createPage(tx, { organizationId: orgId, title: "Alice only", actorUserId: users.alice });
      await setPagePermission(tx, page.id, { type: "user", id: users.alice }, "full");
      return page.id;
    });
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  /** Every id of `table` that `userId` can see — the RLS view, nothing else. */
  async function visibleIds(userId: string, table: "project" | "issue" | "issue_comment" | "sprint" | "page") {
    const rows = await withAuthorizedTenant(ctxOf(userId), (tx) => tx.execute<{ id: string }>(sql`select id from ${sql.identifier(table)}`));
    return new Set(rows.map((r) => r.id));
  }

  describe("a team member", () => {
    it("sees their own team's project and nothing from another team or the unassigned project", async () => {
      const seen = await visibleIds(users.alice, "project");
      expect(seen.has(fx.projectA)).toBe(true);
      expect(seen.has(fx.projectB)).toBe(false);
      expect(seen.has(fx.projectUnassigned)).toBe(false);
    });

    it("inherits the same scoping on issues, comments (child of issue), and sprints (via board)", async () => {
      const [issues, comments, sprints] = await Promise.all([
        visibleIds(users.alice, "issue"),
        visibleIds(users.alice, "issue_comment"),
        visibleIds(users.alice, "sprint"),
      ]);
      expect(issues.has(fx.issueA) && !issues.has(fx.issueB)).toBe(true);
      expect(comments.has(fx.commentA) && !comments.has(fx.commentB)).toBe(true);
      expect(sprints.has(fx.sprintA) && !sprints.has(fx.sprintB)).toBe(true);
    });

    it("sees their project's pages and Workspace pages, but not another team's team-space pages", async () => {
      const seen = await visibleIds(users.alice, "page");
      expect(seen.has(fx.pageProjectA)).toBe(true);
      expect(seen.has(fx.pageWorkspace)).toBe(true);
      expect(seen.has(fx.pageTeamB)).toBe(false);
      // bob's mirror image: his own team page, not alice's project page
      const bobSees = await visibleIds(users.bob, "page");
      expect(bobSees.has(fx.pageTeamB)).toBe(true);
      expect(bobSees.has(fx.pageProjectA)).toBe(false);
    });

    it("cannot write into another team's project — RLS rejects the insert, not just the read", async () => {
      await expect(
        withAuthorizedTenant(ctxOf(users.alice), async (tx) => {
          const [status] = await tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, fx.projectB));
          const [type] = await tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, fx.projectB));
          // workflow_status/issue_type aren't RLS'd (documented residual), so
          // these resolve — the issue insert itself is what must fail.
          return createIssue(tx, { organizationId: orgId, projectId: fx.projectB, typeId: type!.id, statusId: status!.id, title: "sneaky", reporterId: users.alice });
        }),
      ).rejects.toThrow();
    });

    it("only retrieves embeddings (Ask Kompast context) for entities they can see", async () => {
      const vector = `[${new Array(1536).fill(0).join(",")}]`;
      await admin.execute(sql`
        insert into embedding (id, organization_id, entity_type, entity_id, chunk_index, content, vector) values
          (${id("emb")}, ${orgId}, 'issue', ${fx.issueA}, 0, 'A', ${vector}::vector),
          (${id("emb")}, ${orgId}, 'issue', ${fx.issueB}, 0, 'B', ${vector}::vector),
          (${id("emb")}, ${orgId}, 'comment', ${fx.commentB}, 0, 'B comment', ${vector}::vector),
          (${id("emb")}, ${orgId}, 'page', ${fx.pageTeamB}, 0, 'B page', ${vector}::vector)
      `);
      const rows = await withAuthorizedTenant(ctxOf(users.alice), (tx) => tx.select({ content: schema.embedding.content }).from(schema.embedding));
      expect(rows.map((r) => r.content).sort()).toEqual(["A"]);
    });
  });

  describe("the super admin", () => {
    it("sees every team's projects, issues, and pages, plus the unassigned project", async () => {
      const [projects, issues, pages] = await Promise.all([
        visibleIds(users.superAdmin, "project"),
        visibleIds(users.superAdmin, "issue"),
        visibleIds(users.superAdmin, "page"),
      ]);
      for (const p of [fx.projectA, fx.projectB, fx.projectUnassigned]) expect(projects.has(p)).toBe(true);
      for (const i of [fx.issueA, fx.issueB]) expect(issues.has(i)).toBe(true);
      for (const p of [fx.pageProjectA, fx.pageTeamB, fx.pageWorkspace]) expect(pages.has(p)).toBe(true);
    });

    it("can open a restricted page they hold no grant on (canAccessPage bypass)", async () => {
      const [superCan, bobCan] = await Promise.all([
        withAuthorizedTenant(ctxOf(users.superAdmin), (tx) => canAccessPage(tx, fx.pageRestricted, ctxOf(users.superAdmin), "full")),
        withAuthorizedTenant(ctxOf(users.bob), (tx) => canAccessPage(tx, fx.pageRestricted, ctxOf(users.bob))),
      ]);
      expect(superCan).toBe(true);
      expect(bobCan).toBe(false);
    });
  });

  describe("everyone else", () => {
    it("a workspace owner who isn't the super admin sees only Workspace content, no team's projects", async () => {
      const [projects, pages] = await Promise.all([visibleIds(users.owner, "project"), visibleIds(users.owner, "page")]);
      expect(projects.size).toBe(0);
      expect(pages.has(fx.pageWorkspace)).toBe(true);
      expect(pages.has(fx.pageProjectA) || pages.has(fx.pageTeamB)).toBe(false);
    });

    it("a member in no team still sees Workspace pages", async () => {
      const pages = await visibleIds(users.loner, "page");
      expect(pages.has(fx.pageWorkspace)).toBe(true);
      expect(pages.has(fx.pageTeamB)).toBe(false);
    });
  });

  describe("team list (sidebar)", () => {
    it("marks teams the viewer isn't in as locked, withholding counts but naming the admins to ask", async () => {
      const teams = await withAuthorizedTenant(ctxOf(users.alice), (tx) => listTeamsForWorkspace(tx, ctxOf(users.alice)));
      const a = teams.find((t) => t.id === teamA)!;
      const b = teams.find((t) => t.id === teamB)!;
      expect(a).toMatchObject({ locked: false, myRole: "admin", projectCount: 1 });
      expect(b).toMatchObject({ locked: true, myRole: null, memberCount: null, projectCount: null, adminNames: [users.bob] });
    });

    it("never locks anything for the super admin", async () => {
      const teams = await withAuthorizedTenant(ctxOf(users.superAdmin), (tx) => listTeamsForWorkspace(tx, ctxOf(users.superAdmin)));
      expect(teams.filter((t) => t.id === teamA || t.id === teamB).every((t) => !t.locked)).toBe(true);
    });
  });

  describe("people pickers and notifications", () => {
    it("only the owning team and the super admin are assignable on a project", async () => {
      const users_ = await withAuthorizedTenant(ctxOf(users.alice), (tx) => listAssignableUsers(tx, { organizationId: orgId, projectId: fx.projectA }));
      expect(users_.map((u) => u.userId).sort()).toEqual([users.alice, users.superAdmin].sort());
    });

    it("notify() drops a recipient who can't see the issue — no inbox row, no email — and delivers to one who can", async () => {
      const send = (userId: string) =>
        withAuthorizedTenant(ctxOf(users.alice), (tx) =>
          notify(tx, { organizationId: orgId, userId, eventType: "issue.assigned", entityType: "issue", entityId: fx.issueA, title: "secret title", email: { to: `${userId}@example.com`, actionUrl: "x", actionLabel: "x" } }),
        );
      expect(await send(users.bob)).toEqual({ notificationId: null, emailQueued: false });
      expect((await send(users.superAdmin)).notificationId).not.toBeNull();

      const bobRows = await admin.select().from(schema.notification).where(eq(schema.notification.userId, users.bob));
      expect(bobRows).toHaveLength(0);
    });

    it("notify() respects page restrictions too, not just team spaces", async () => {
      const r = await withAuthorizedTenant(ctxOf(users.alice), (tx) =>
        notify(tx, { organizationId: orgId, userId: users.loner, eventType: "page.mentioned", entityType: "page", entityId: fx.pageRestricted, title: "t" }),
      );
      expect(r.notificationId).toBeNull();
    });
  });

  describe("team invitations", () => {
    const inviteeEmail = "Test-Vis-Invitee@Example.com";

    it("a team admin's invitation is idempotent while pending, refuses existing members, and is cancellable", async () => {
      const ctx = ctxOf(users.alice);
      const first = await withAuthorizedTenant(ctx, (tx) => createTeamInvitation(tx, { organizationId: orgId, teamId: teamA, email: inviteeEmail, teamRole: "admin", inviterId: users.alice }));
      const again = await withAuthorizedTenant(ctx, (tx) => createTeamInvitation(tx, { organizationId: orgId, teamId: teamA, email: inviteeEmail.toLowerCase(), teamRole: "admin", inviterId: users.alice }));
      expect(first.created).toBe(true);
      expect(again).toEqual({ id: first.id, created: false });

      const [row] = await admin.select().from(schema.invitation).where(eq(schema.invitation.id, first.id));
      // Workspace role is always plain member — a team admin can't mint workspace admins (M3).
      expect(row).toMatchObject({ role: "member", teamId: teamA, teamRole: "admin", status: "pending", email: inviteeEmail.toLowerCase() });

      await expect(
        withAuthorizedTenant(ctx, (tx) => createTeamInvitation(tx, { organizationId: orgId, teamId: teamA, email: `${users.bob}@example.com`, teamRole: "member", inviterId: users.alice })),
      ).rejects.toThrow(TeamInvitationError);

      // Another team's admin can't cancel it: cancellation is scoped by teamId.
      await cancelTeamInvitation(adminDb, { teamId: teamB, invitationId: first.id });
      expect(await listTeamInvitations(adminDb, teamA)).toHaveLength(1);
      await cancelTeamInvitation(adminDb, { teamId: teamA, invitationId: first.id });
      expect(await listTeamInvitations(adminDb, teamA)).toHaveLength(0);
    });

    it("after the plugin accepts, the invitee is in the team with the invited team role — and sees the team's content", async () => {
      const inviteeId = "test-vis-invitee";
      await admin.delete(schema.user).where(eq(schema.user.id, inviteeId));
      const { id: invitationId } = await withAuthorizedTenant(ctxOf(users.alice), (tx) =>
        createTeamInvitation(tx, { organizationId: orgId, teamId: teamA, email: "test-vis-invitee@example.com", teamRole: "admin", inviterId: users.alice }),
      );
      // Stand-in for Better Auth's acceptInvitation (needs a real signed
      // session): it flips the status and creates the member row. The
      // team_member row is deliberately NOT created here, proving
      // applyAcceptedTeamInvitation doesn't rely on the plugin doing it.
      await admin.insert(schema.user).values({ id: inviteeId, name: "Invitee", email: "test-vis-invitee@example.com" });
      await admin.insert(schema.member).values({ id: id("mem"), organizationId: orgId, userId: inviteeId, role: "member" });
      await admin.update(schema.invitation).set({ status: "accepted" }).where(eq(schema.invitation.id, invitationId));

      await withAuthorizedTenant(ctxOf(inviteeId), (tx) => applyAcceptedTeamInvitation(tx, { invitationId, userId: inviteeId }));

      const [tm] = await admin.select().from(schema.teamMember).where(eq(schema.teamMember.userId, inviteeId));
      expect(tm).toMatchObject({ teamId: teamA, role: "admin" });
      expect((await visibleIds(inviteeId, "project")).has(fx.projectA)).toBe(true);

      await admin.delete(schema.user).where(eq(schema.user.id, inviteeId));
    });
  });

  describe("assigning a project to a team", () => {
    it("makes a legacy unassigned project visible to that team's members (and its key must be free on the team)", async () => {
      const legacy = id("proj");
      await admin.insert(schema.project).values({ id: legacy, organizationId: orgId, teamId: null, key: "VISL", name: "Legacy" });
      expect((await visibleIds(users.alice, "project")).has(legacy)).toBe(false);

      await withAuthorizedTenant(ctxOf(users.superAdmin), (tx) => assignProjectToTeam(tx, { projectId: legacy, teamId: teamA, organizationId: orgId }));
      expect((await visibleIds(users.alice, "project")).has(legacy)).toBe(true);

      const clash = id("proj");
      await admin.insert(schema.project).values({ id: clash, organizationId: orgId, teamId: null, key: "VISA", name: "Clashes with team A's VISA" });
      await expect(
        withAuthorizedTenant(ctxOf(users.superAdmin), (tx) => assignProjectToTeam(tx, { projectId: clash, teamId: teamA, organizationId: orgId })),
      ).rejects.toThrow(ProjectKeyConflictError);
    });
  });

  describe("page spaces", () => {
    it("a child page inherits its parent's team space, and an explicitly different space is rejected", async () => {
      const child = await withAuthorizedTenant(ctxOf(users.bob), (tx) =>
        createPage(tx, { organizationId: orgId, parentPageId: fx.pageTeamB, title: "child", actorUserId: users.bob }),
      );
      expect(child.teamId).toBe(teamB);
      expect(child.projectId).toBeNull();

      await expect(
        withAuthorizedTenant(ctxOf(users.bob), (tx) =>
          createPage(tx, { organizationId: orgId, parentPageId: fx.pageTeamB, teamId: null, projectId: null, title: "escapee", actorUserId: users.bob }),
        ),
      ).rejects.toThrow(PageSpaceError);
    });

    it("moving a subtree to another space carries every descendant with it", async () => {
      const { root, child, grandchild } = await withAuthorizedTenant(ctxOf(users.bob), async (tx) => {
        const root = await createPage(tx, { organizationId: orgId, teamId: teamB, title: "root", actorUserId: users.bob });
        const child = await createPage(tx, { organizationId: orgId, parentPageId: root.id, title: "child", actorUserId: users.bob });
        const grandchild = await createPage(tx, { organizationId: orgId, parentPageId: child.id, title: "grandchild", actorUserId: users.bob });
        await movePage(tx, root.id, { parentPageId: null, space: { projectId: null, teamId: null } });
        return { root, child, grandchild };
      });

      const rows = await admin.select({ id: schema.page.id, teamId: schema.page.teamId }).from(schema.page).where(inArray(schema.page.id, [root.id, child.id, grandchild.id]));
      expect(rows.every((r) => r.teamId === null)).toBe(true);
      // ...and they are now visible to someone outside team B
      const alicePages = await visibleIds(users.alice, "page");
      expect(alicePages.has(grandchild.id)).toBe(true);
    });

    it("refuses to move a page under its own descendant", async () => {
      await expect(
        withAuthorizedTenant(ctxOf(users.bob), async (tx) => {
          const root = await createPage(tx, { organizationId: orgId, teamId: teamB, title: "loop root", actorUserId: users.bob });
          const child = await createPage(tx, { organizationId: orgId, parentPageId: root.id, title: "loop child", actorUserId: users.bob });
          await movePage(tx, root.id, { parentPageId: child.id });
        }),
      ).rejects.toThrow(PageSpaceError);
    });

    it("the database itself forbids a page in both a project and a team", async () => {
      await expect(
        admin.insert(schema.page).values({ id: id("page"), organizationId: orgId, projectId: fx.projectA, teamId: teamA, title: "both", rank: "a0" }),
      ).rejects.toThrow();
    });
  });
});
