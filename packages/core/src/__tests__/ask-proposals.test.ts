import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminDb, db, eq, schema, withTenant, type Json } from "@kompast/db";
import { withAuthorizedTenant, type AuthContext } from "../permissions";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { proposeAskWrite, type AskProposal } from "../ask-tools";
import { applyAskProposal, discardAskProposal } from "../ask-proposals";
import { ConflictError, NotFoundError } from "../errors";
import { id } from "../ids";

/**
 * Direct tests of the Ask Kompast write path (propose → Apply / Discard). These don't need AI settings, so they
 * don't touch system_settings. Everything here is scoped to this file's own org/user/team ids.
 */
describe("ask proposals (propose → apply / discard)", () => {
  const orgId = "test-ask-prop-org";
  const userId = "test-ask-prop-user";
  const otherUserId = "test-ask-prop-other";
  const twinAId = "test-ask-prop-twin-a";
  const twinBId = "test-ask-prop-twin-b";
  const teamId = "test-ask-prop-team";
  const hiddenTeamId = "test-ask-prop-hidden-team";
  const ctx: AuthContext = { userId, organizationId: orgId };
  const otherCtx: AuthContext = { userId: otherUserId, organizationId: orgId };

  async function cleanup() {
    // Deleting the thread cascades to its messages.
    await db.delete(schema.aiThread).where(eq(schema.aiThread.organizationId, orgId));
    await db.delete(schema.embeddingIndexQueue).where(eq(schema.embeddingIndexQueue.organizationId, orgId));
    // Pages reference team/project, so they go first; adminDb because RLS hides them from a plain delete.
    await adminDb.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await db.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await db.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    for (const uid of [userId, otherUserId, twinAId, twinBId]) await db.delete(schema.user).where(eq(schema.user.id, uid));
  }

  beforeEach(async () => {
    await cleanup();
    await db.insert(schema.organization).values({ id: orgId, name: "Ask Proposal Org", slug: orgId });
    await db.insert(schema.user).values([
      { id: userId, name: "Ask Proposal User", email: `${userId}@example.com` },
      { id: otherUserId, name: "Ask Proposal Other", email: `${otherUserId}@example.com` },
    ]);
    // Both users are workspace members (so requireMembership passes); only `userId` is on the team that owns the project.
    await db.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: otherUserId, role: "member" },
    ]);
    await db.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "Ask Team" });
    await db.insert(schema.teamMember).values({ id: `tmem-${teamId}-${userId}`, teamId, userId, membershipKey: `${teamId}:${userId}` });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  /** Creates the project as the system (admin connection), so this helper works for any team. */
  function seedProjectOn(team: string, key: string) {
    return withTenant(adminDb, { organizationId: orgId, userId: "system" }, (tx) =>
      createProject(tx, { organizationId: orgId, teamId: team, key, name: `${key} project`, actorUserId: userId }),
    );
  }

  async function seedProject() {
    return withAuthorizedTenant(ctx, (tx) => createProject(tx, { organizationId: orgId, teamId, key: "apr", name: "APR project", actorUserId: userId }));
  }

  /** Stores proposals on an assistant message in a thread the owner created, the way askKompast does after a turn. */
  async function seedAskMessage(proposals: AskProposal[], owner: AuthContext = ctx) {
    const threadId = id("thread");
    const messageId = id("msg");
    await withAuthorizedTenant(owner, async (tx) => {
      await tx.insert(schema.aiThread).values({ id: threadId, organizationId: orgId, userId: owner.userId, title: "Drafts" });
      await tx.insert(schema.aiMessage).values({ id: messageId, threadId, role: "assistant", content: "Drafted it.", proposals: proposals as unknown as Json });
    });
    return { threadId, messageId };
  }

  async function draft(name: string, input: Record<string, unknown>) {
    const result = await proposeAskWrite(ctx, { id: `call_${name}`, name, input });
    return { ...result, parsed: JSON.parse(result.output) as Record<string, unknown> };
  }

  async function issuesIn(projectId: string) {
    return adminDb.select().from(schema.issue).where(eq(schema.issue.projectId, projectId));
  }

  async function storedProposals(messageId: string): Promise<AskProposal[]> {
    const [row] = await adminDb.select().from(schema.aiMessage).where(eq(schema.aiMessage.id, messageId));
    return (row!.proposals ?? []) as unknown as AskProposal[];
  }

  describe("proposeAskWrite", () => {
    it("drafts an issue without creating it, and previews the full description", async () => {
      const { projectId } = await seedProject();
      const longDescription = `Repro: ${"step ".repeat(200)}end`;

      const { output, proposal, parsed } = await draft("create_issue", {
        projectKey: "apr",
        title: "Login fails on SSO",
        description: longDescription,
        priority: "High",
        assignee: "me",
      });

      expect(parsed).toMatchObject({ status: "proposed", proposalId: proposal!.id });
      expect(output).toContain("Nothing has been created yet");
      expect(proposal).toMatchObject({ kind: "create_issue", status: "pending" });
      expect(proposal!.preview.title).toBe("Login fails on SSO");
      expect(proposal!.preview.lines).toEqual(expect.arrayContaining(["Project: APR", "Priority: High"]));
      expect(proposal!.preview.body).toBe(longDescription);
      expect(await issuesIn(projectId)).toHaveLength(0);
    });

    it("drafts a comment and a page without writing either", async () => {
      const { projectId } = await seedProject();
      const { issueId } = await withAuthorizedTenant(ctx, async (tx) => {
        const [type] = await tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, projectId));
        const [status] = await tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId));
        return createIssue(tx, { organizationId: orgId, projectId, typeId: type!.id, statusId: status!.id, title: "Existing issue", reporterId: userId });
      });
      const [issue] = await adminDb.select().from(schema.issue).where(eq(schema.issue.id, issueId));
      const issueKey = `APR-${issue!.keySeq}`;

      const comment = await draft("add_comment", { issueKey, body: "Looks good to me." });
      expect(comment.proposal).toMatchObject({ kind: "add_comment", status: "pending", preview: { title: `${issueKey} · Existing issue`, body: "Looks good to me." } });

      const page = await draft("create_page", { title: "Runbook", content: "# Steps\n\nDo the thing.", projectKey: "apr" });
      expect(page.proposal).toMatchObject({ kind: "create_page", preview: { title: "Runbook", lines: ["Space: APR project"] } });

      expect(await adminDb.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, issueId))).toHaveLength(0);
      expect(await adminDb.select().from(schema.page).where(eq(schema.page.organizationId, orgId))).toHaveLength(0);
    });

    it("rejects an unknown project with an error result and no proposal", async () => {
      await seedProject();
      const { output, proposal } = await draft("create_issue", { projectKey: "NOPE", title: "x" });
      expect(proposal).toBeUndefined();
      expect(JSON.parse(output).error).toMatch(/NOPE/);
    });

    it("rejects a project in a team the user is not on, as if it did not exist", async () => {
      await db.insert(schema.team).values({ id: hiddenTeamId, organizationId: orgId, name: "Hidden Team" });
      await seedProjectOn(hiddenTeamId, "hid");

      const { output, proposal } = await draft("create_issue", { projectKey: "hid", title: "Secret plan" });
      expect(proposal).toBeUndefined();
      expect(JSON.parse(output).error).toMatch(/not found/i);
    });

    it("refuses an ambiguous assignee name, listing the candidates, with no proposal", async () => {
      await seedProject();
      await db.insert(schema.user).values([
        { id: twinAId, name: "Twin Name", email: `${twinAId}@example.com` },
        { id: twinBId, name: "Twin Name", email: `${twinBId}@example.com` },
      ]);
      await db.insert(schema.member).values([
        { id: id("mem"), organizationId: orgId, userId: twinAId, role: "member" },
        { id: id("mem"), organizationId: orgId, userId: twinBId, role: "member" },
      ]);

      const { output, proposal } = await draft("create_issue", { projectKey: "apr", title: "Assign me", assignee: "Twin Name" });
      expect(proposal).toBeUndefined();
      expect(JSON.parse(output).error).toMatch(/matches several members/);
    });

    it("refuses a page that is both in a project and private", async () => {
      await seedProject();
      const { output, proposal } = await draft("create_page", { title: "Mixed", content: "x", projectKey: "apr", private: true });
      expect(proposal).toBeUndefined();
      expect(JSON.parse(output).error).toMatch(/not both/);
    });
  });

  describe("applyAskProposal", () => {
    it("creates the issue with origin 'ai', records the history under 'ai', and is idempotent on a second Apply", async () => {
      const { projectId } = await seedProject();
      const { proposal } = await draft("create_issue", { projectKey: "apr", title: "From Ask", description: "Details here" });
      const { messageId } = await seedAskMessage([proposal!]);

      const applied = await applyAskProposal(ctx, { messageId, proposalId: proposal!.id });

      expect(applied).toMatchObject({ status: "applied", result: { projectKey: "APR", teamId } });
      expect(applied.result!.issueKey).toMatch(/^APR-\d+$/);

      const issues = await issuesIn(projectId);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ title: "From Ask", origin: "ai", originClient: "ask-kompast", reporterId: userId });
      expect(issues[0]!.id).toBe(applied.result!.issueId);

      const history = await adminDb.select().from(schema.issueHistory).where(eq(schema.issueHistory.issueId, issues[0]!.id));
      expect(history.length).toBeGreaterThan(0);
      expect(history.every((h) => h.origin === "ai")).toBe(true);

      const again = await applyAskProposal(ctx, { messageId, proposalId: proposal!.id });
      expect(again).toEqual(applied);
      expect(await issuesIn(projectId)).toHaveLength(1);
      expect((await storedProposals(messageId))[0]!.status).toBe("applied");
    });

    it("refuses to apply a discarded proposal, and refuses to discard an applied one", async () => {
      await seedProject();
      const { proposal: discardedFirst } = await draft("create_issue", { projectKey: "apr", title: "Discard me" });
      const { messageId: m1 } = await seedAskMessage([discardedFirst!]);
      await discardAskProposal(ctx, { messageId: m1, proposalId: discardedFirst!.id });
      await expect(applyAskProposal(ctx, { messageId: m1, proposalId: discardedFirst!.id })).rejects.toBeInstanceOf(ConflictError);

      const { proposal: appliedFirst } = await draft("create_issue", { projectKey: "apr", title: "Apply me" });
      const { messageId: m2 } = await seedAskMessage([appliedFirst!]);
      await applyAskProposal(ctx, { messageId: m2, proposalId: appliedFirst!.id });
      await expect(discardAskProposal(ctx, { messageId: m2, proposalId: appliedFirst!.id })).rejects.toBeInstanceOf(ConflictError);
    });

    it("a pending proposal can be discarded, and discarding twice is harmless", async () => {
      await seedProject();
      const { proposal } = await draft("create_issue", { projectKey: "apr", title: "Maybe later" });
      const { messageId } = await seedAskMessage([proposal!]);

      expect((await discardAskProposal(ctx, { messageId, proposalId: proposal!.id })).status).toBe("discarded");
      expect((await discardAskProposal(ctx, { messageId, proposalId: proposal!.id })).status).toBe("discarded");
      expect((await storedProposals(messageId))[0]!.status).toBe("discarded");
    });

    it("another user cannot apply or discard someone else's proposal: it is simply not found", async () => {
      const { projectId } = await seedProject();
      const { proposal } = await draft("create_issue", { projectKey: "apr", title: "Mine only" });
      const { messageId } = await seedAskMessage([proposal!]);

      await expect(applyAskProposal(otherCtx, { messageId, proposalId: proposal!.id })).rejects.toBeInstanceOf(NotFoundError);
      await expect(discardAskProposal(otherCtx, { messageId, proposalId: proposal!.id })).rejects.toBeInstanceOf(NotFoundError);
      expect(await issuesIn(projectId)).toHaveLength(0);
      expect((await storedProposals(messageId))[0]!.status).toBe("pending");
    });

    it("an unknown proposal id on a real message is not found", async () => {
      await seedProject();
      const { proposal } = await draft("create_issue", { projectKey: "apr", title: "Real" });
      const { messageId } = await seedAskMessage([proposal!]);
      await expect(applyAskProposal(ctx, { messageId, proposalId: "prop_missing" })).rejects.toBeInstanceOf(NotFoundError);
    });

    it("if the user loses access to the project after drafting, Apply fails and nothing is created", async () => {
      const { projectId } = await seedProject();
      const { proposal } = await draft("create_issue", { projectKey: "apr", title: "Too late" });
      const { messageId } = await seedAskMessage([proposal!]);

      await adminDb.delete(schema.teamMember).where(eq(schema.teamMember.userId, userId));

      await expect(applyAskProposal(ctx, { messageId, proposalId: proposal!.id })).rejects.toBeInstanceOf(NotFoundError);
      expect(await issuesIn(projectId)).toHaveLength(0);
      expect((await storedProposals(messageId))[0]!.status).toBe("pending");
    });

    it("adds a comment with origin 'ai' on the issue it was drafted for", async () => {
      const { projectId } = await seedProject();
      const { issueId } = await withAuthorizedTenant(ctx, async (tx) => {
        const [type] = await tx.select().from(schema.issueType).where(eq(schema.issueType.projectId, projectId));
        const [status] = await tx.select().from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId));
        return createIssue(tx, { organizationId: orgId, projectId, typeId: type!.id, statusId: status!.id, title: "Comment target", reporterId: userId });
      });
      const [issue] = await adminDb.select().from(schema.issue).where(eq(schema.issue.id, issueId));
      const { proposal } = await draft("add_comment", { issueKey: `APR-${issue!.keySeq}`, body: "Drafted by Ask" });
      const { messageId } = await seedAskMessage([proposal!]);

      const applied = await applyAskProposal(ctx, { messageId, proposalId: proposal!.id });

      expect(applied.result).toMatchObject({ issueId, issueKey: `APR-${issue!.keySeq}`, teamId });
      const comments = await adminDb.select().from(schema.issueComment).where(eq(schema.issueComment.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ origin: "ai", originClient: "ask-kompast", authorId: userId });
    });

    it("creates a project page and seeds its body through the callback, exactly once", async () => {
      const { projectId } = await seedProject();
      const { proposal } = await draft("create_page", { title: "Runbook", content: "# Steps\n\nDo the thing.", projectKey: "apr" });
      const { messageId } = await seedAskMessage([proposal!]);
      const seedPageBody = vi.fn(async () => {});

      const applied = await applyAskProposal(ctx, { messageId, proposalId: proposal!.id }, { seedPageBody });

      expect(seedPageBody).toHaveBeenCalledTimes(1);
      const [, pageId, markdown, org] = seedPageBody.mock.calls[0] as unknown as [unknown, string, string, string];
      expect(pageId).toBe(applied.result!.pageId);
      expect(markdown).toBe("# Steps\n\nDo the thing.");
      expect(org).toBe(orgId);

      const [page] = await adminDb.select().from(schema.page).where(eq(schema.page.id, pageId));
      expect(page).toMatchObject({ title: "Runbook", projectId, privateOwnerId: null });
    });

    it("a private page lands in the caller's own Private space", async () => {
      await seedProject();
      const { proposal } = await draft("create_page", { title: "Just me", content: "secret", private: true });
      const { messageId } = await seedAskMessage([proposal!]);

      const applied = await applyAskProposal(ctx, { messageId, proposalId: proposal!.id }, { seedPageBody: async () => {} });

      const [page] = await adminDb.select().from(schema.page).where(eq(schema.page.id, applied.result!.pageId!));
      expect(page).toMatchObject({ privateOwnerId: userId, projectId: null, teamId: null });
    });
  });
});
