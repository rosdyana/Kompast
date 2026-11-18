import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, and } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createProject } from "../project";
import { createIssue } from "../issue";
import { addComment } from "../comment";
import { setNotificationPref } from "../notification";
import { withAuthorizedTenant } from "../permissions";
import { InvalidInputError, NotFoundError } from "../errors";
import { id } from "../ids";
import type { Tx } from "../types";
import {
  addCommentReaction,
  listCommentReactions,
  normalizeReactionEmoji,
  removeCommentReaction,
} from "../comment-reaction";

describe("comment reactions", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL!, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-cr-org";
  const teamId = "test-cr-team";
  const authorId = "test-cr-author";
  const reactorId = "test-cr-reactor";
  const teammateId = "test-cr-teammate";
  const outsiderId = "test-cr-outsider";
  const teamUsers = [authorId, reactorId, teammateId];
  const allUsers = [...teamUsers, outsiderId];
  const as = <T>(userId: string, fn: (tx: Tx) => Promise<T>) =>
    withAuthorizedTenant({ userId, organizationId: orgId }, fn);

  async function cleanup() {
    await admin.delete(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    await admin.delete(schema.notification).where(eq(schema.notification.organizationId, orgId));
    await admin.delete(schema.notificationPref).where(eq(schema.notificationPref.organizationId, orgId));
    await admin.delete(schema.project).where(eq(schema.project.organizationId, orgId));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    for (const u of allUsers) await admin.delete(schema.user).where(eq(schema.user.id, u));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "Test CR Org", slug: orgId });
    await admin.insert(schema.user).values(allUsers.map((u) => ({ id: u, name: u, email: `${u}@example.com` })));
    await admin.insert(schema.member).values(allUsers.map((u) => ({ id: id("mem"), organizationId: orgId, userId: u, role: "member" })));
    await admin.insert(schema.team).values({ id: teamId, organizationId: orgId, name: "CR Team" });
    // Only the team members can see the project, its issues and their comments (team-scoped RLS).
    await admin.insert(schema.teamMember).values(
      teamUsers.map((u) => ({ id: `tmem-${teamId}-${u}`, teamId, userId: u, membershipKey: `${teamId}:${u}` })),
    );
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  /** A project + issue + one comment written by the author. */
  async function seedComment() {
    return as(authorId, async (tx) => {
      const { projectId, issueTypes, statuses } = await createProject(tx, {
        organizationId: orgId,
        teamId,
        key: "crx",
        name: "CRX",
        actorUserId: authorId,
      });
      const { issueId } = await createIssue(tx, {
        organizationId: orgId,
        projectId,
        typeId: issueTypes[0]!.id,
        statusId: statuses[0]!.id,
        title: "Reactable issue",
        reporterId: authorId,
      });
      const { commentId } = await addComment(tx, { issueId, authorId, bodyJson: { text: "hello" } });
      return { issueId, commentId };
    });
  }

  const react = (userId: string, commentId: string, emoji: string, origin: "user" | "import" = "user") =>
    as(userId, (tx) => addCommentReaction(tx, { organizationId: orgId, commentId, userId, emoji, origin }));

  const reactionRows = (commentId: string) =>
    admin.select().from(schema.issueCommentReaction).where(eq(schema.issueCommentReaction.commentId, commentId));

  const reactionNotifications = () =>
    admin
      .select()
      .from(schema.notification)
      .where(and(eq(schema.notification.organizationId, orgId), eq(schema.notification.eventType, "issue.comment_reacted")));

  it("adding the same reaction twice is idempotent", async () => {
    const { commentId } = await seedComment();

    expect(await react(reactorId, commentId, "👍")).toEqual({ added: true });
    expect(await react(reactorId, commentId, "👍")).toEqual({ added: false });

    expect(await reactionRows(commentId)).toHaveLength(1);
    expect(await reactionNotifications()).toHaveLength(1);
  });

  it("removing deletes only the caller's own reaction, and is idempotent", async () => {
    const { commentId } = await seedComment();
    await react(reactorId, commentId, "👍");
    await react(teammateId, commentId, "👍");

    const removed = await as(reactorId, (tx) => removeCommentReaction(tx, { commentId, userId: reactorId, emoji: "👍" }));
    expect(removed).toEqual({ removed: true });
    const again = await as(reactorId, (tx) => removeCommentReaction(tx, { commentId, userId: reactorId, emoji: "👍" }));
    expect(again).toEqual({ removed: false });

    const rows = await reactionRows(commentId);
    expect(rows.map((r) => r.userId)).toEqual([teammateId]);
  });

  it("counts, reactor lists and emoji order are right", async () => {
    const { commentId } = await seedComment();
    await react(reactorId, commentId, "👍"); // first emoji seen
    await react(teammateId, commentId, "🚀");
    await react(authorId, commentId, "👍");
    await react(teammateId, commentId, "👍");

    const map = await as(authorId, (tx) => listCommentReactions(tx, [commentId]));
    expect(map.get(commentId)).toEqual([
      { emoji: "👍", count: 3, userIds: [reactorId, authorId, teammateId] },
      { emoji: "🚀", count: 1, userIds: [teammateId] },
    ]);
  });

  it("listCommentReactions returns an empty map for no comments or comments without reactions", async () => {
    const { commentId } = await seedComment();
    expect((await as(authorId, (tx) => listCommentReactions(tx, []))).size).toBe(0);
    expect((await as(authorId, (tx) => listCommentReactions(tx, [commentId]))).has(commentId)).toBe(false);
  });

  it("rejects invalid input and accepts single emoji with ZWJ, flag, keycap and skin tone", () => {
    for (const bad of ["abc", "👍👍", "", "   ", "a👍", "1", "x".repeat(40)]) {
      expect(() => normalizeReactionEmoji(bad)).toThrow(InvalidInputError);
    }
    for (const good of ["👨‍👩‍👧", "🇹🇼", "1️⃣", "👍🏽", "❤️", "🚀", "  👀  "]) {
      expect(() => normalizeReactionEmoji(good)).not.toThrow();
    }
    expect(normalizeReactionEmoji("  👀  ")).toBe("👀");
  });

  it("treats 👍 with and without the U+FE0F selector as one reaction, but keeps it where it's needed", async () => {
    expect(normalizeReactionEmoji("👍\u{FE0F}")).toBe("👍");
    expect(normalizeReactionEmoji("❤\u{FE0F}")).toBe("❤\u{FE0F}");
    expect(normalizeReactionEmoji("1\u{FE0F}\u{20E3}")).toBe("1\u{FE0F}\u{20E3}");
    const { commentId } = await seedComment();
    expect(await react(reactorId, commentId, "👍\u{FE0F}")).toEqual({ added: true });
    expect(await react(reactorId, commentId, "👍")).toEqual({ added: false });
    const summaries = (await as(authorId, (tx) => listCommentReactions(tx, [commentId]))).get(commentId);
    expect(summaries).toEqual([{ emoji: "👍", count: 1, userIds: [reactorId] }]);
  });

  it("invalid input is rejected by addCommentReaction before anything is written", async () => {
    const { commentId } = await seedComment();
    await expect(react(reactorId, commentId, "abc")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(react(reactorId, commentId, "👍👍")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(react(reactorId, commentId, "")).rejects.toBeInstanceOf(InvalidInputError);
    expect(await reactionRows(commentId)).toHaveLength(0);
  });

  it("a user outside the issue's team gets NotFoundError, and their reaction is not stored", async () => {
    const { commentId } = await seedComment();
    await expect(react(outsiderId, commentId, "👍")).rejects.toBeInstanceOf(NotFoundError);
    expect(await reactionRows(commentId)).toHaveLength(0);
  });

  it("a missing comment is NotFoundError", async () => {
    await seedComment();
    await expect(react(reactorId, "cmt_does_not_exist", "👍")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("RLS blocks deleting someone else's reaction with a direct delete inside withAuthorizedTenant", async () => {
    const { commentId } = await seedComment();
    await react(reactorId, commentId, "👍");
    const [ownRow] = await reactionRows(commentId);
    expect(ownRow).toBeDefined();

    await as(teammateId, async (tx) => {
      await tx.delete(schema.issueCommentReaction).where(eq(schema.issueCommentReaction.id, ownRow!.id));
    });

    const after = await reactionRows(commentId);
    expect(after.map((r) => r.id)).toEqual([ownRow!.id]);
  });

  it("the author is notified in-app once, with no email, when someone else reacts", async () => {
    const { commentId, issueId } = await seedComment();
    await react(reactorId, commentId, "👍");

    const notes = await reactionNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: authorId, entityType: "issue", entityId: issueId });
    expect(notes[0]!.title).toMatch(/^test-cr-reactor reacted 👍 to your comment on CRX-\d+$/);

    const emails = await admin.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    expect(emails).toHaveLength(0);
  });

  it("a self-reaction does not notify the author", async () => {
    const { commentId } = await seedComment();
    await react(authorId, commentId, "👍");
    expect(await reactionNotifications()).toHaveLength(0);
  });

  it("the author is not notified when their reaction preference is off", async () => {
    const { commentId } = await seedComment();
    await as(authorId, (tx) =>
      setNotificationPref(tx, { organizationId: orgId, userId: authorId, eventType: "issue.comment_reacted", inApp: false }),
    );
    await react(reactorId, commentId, "👍");
    expect(await reactionNotifications()).toHaveLength(0);
    // The reaction itself is still stored.
    expect(await reactionRows(commentId)).toHaveLength(1);
  });

  it("imported reactions are stored but do not notify", async () => {
    const { commentId } = await seedComment();
    expect(await react(reactorId, commentId, "👍", "import")).toEqual({ added: true });
    expect(await reactionNotifications()).toHaveLength(0);
  });
});
