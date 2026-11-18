import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema, eq, inArray, and } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPage } from "../page";
import { addPageComment } from "../page-comment";
import { notifyPageBodyMention } from "../page-mention";
import { withAuthorizedTenant } from "../permissions";
import { id } from "../ids";

/**
 * @mentions in doc comments and doc bodies. Every notification goes through
 * withAuthorizedTenant as the author, so the recipient's visibility is checked
 * by notifyPageMentions/canUserSeeEntity, not by the caller's RLS view.
 * Uses unique test-pm-* ids so it can't collide with other core test files.
 */
describe("page mentions", () => {
  const env = loadEnv();
  const adminClient = postgres(env.DATABASE_ADMIN_URL!, { max: 1 });
  const admin = drizzle(adminClient);

  const orgId = "test-pm-org";
  const teamAId = "test-pm-team-a";
  const teamBId = "test-pm-team-b";
  const users = {
    author: "test-pm-author", // member of team A
    member: "test-pm-member", // member of team A — can see team A pages
    outsider: "test-pm-outsider", // member of team B only — cannot see team A pages
  };
  const ctx = { userId: users.author, organizationId: orgId };

  async function cleanup() {
    await admin.delete(schema.notification).where(eq(schema.notification.organizationId, orgId));
    await admin.delete(schema.emailOutbox).where(eq(schema.emailOutbox.organizationId, orgId));
    await admin.delete(schema.page).where(eq(schema.page.organizationId, orgId));
    await admin.delete(schema.teamMember).where(inArray(schema.teamMember.teamId, [teamAId, teamBId]));
    await admin.delete(schema.team).where(eq(schema.team.organizationId, orgId));
    await admin.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await admin.delete(schema.user).where(inArray(schema.user.id, Object.values(users)));
    await admin.delete(schema.organization).where(eq(schema.organization.id, orgId));
  }

  beforeEach(async () => {
    await cleanup();
    await admin.insert(schema.organization).values({ id: orgId, name: "PM Org", slug: orgId });
    await admin.insert(schema.user).values(Object.values(users).map((u) => ({ id: u, name: u, email: `${u}@example.com` })));
    await admin.insert(schema.member).values(
      Object.values(users).map((u) => ({ id: id("mem"), organizationId: orgId, userId: u, role: "member" })),
    );
    await admin.insert(schema.team).values([
      { id: teamAId, organizationId: orgId, name: "Team A" },
      { id: teamBId, organizationId: orgId, name: "Team B" },
    ]);
    await admin.insert(schema.teamMember).values([
      { id: `tmem-${teamAId}-${users.author}`, teamId: teamAId, userId: users.author, membershipKey: `${teamAId}:${users.author}` },
      { id: `tmem-${teamAId}-${users.member}`, teamId: teamAId, userId: users.member, membershipKey: `${teamAId}:${users.member}` },
      { id: `tmem-${teamBId}-${users.outsider}`, teamId: teamBId, userId: users.outsider, membershipKey: `${teamBId}:${users.outsider}` },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await adminClient.end();
  });

  async function seedTeamPage(title: string) {
    return withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title, teamId: teamAId, actorUserId: users.author }));
  }

  async function seedPrivatePage(title: string) {
    return withAuthorizedTenant(ctx, (tx) => createPage(tx, { organizationId: orgId, title, privateOwnerId: users.author, actorUserId: users.author }));
  }

  async function pageMentionNotifications() {
    return admin
      .select()
      .from(schema.notification)
      .where(and(eq(schema.notification.organizationId, orgId), eq(schema.notification.eventType, "page.mentioned")));
  }

  const mentionBody = (userId: string, name: string) => [
    { type: "paragraph", content: [{ type: "userMention", props: { userId, name } }] },
  ];

  it("addPageComment notifies a mentioned member who can see the page", async () => {
    const page = await seedTeamPage("Roadmap");

    await withAuthorizedTenant(ctx, (tx) =>
      addPageComment(tx, { pageId: page.id, blockId: "page", authorId: users.author, bodyJson: mentionBody(users.member, "Member") }),
    );

    const rows = await pageMentionNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: users.member, entityType: "page", entityId: page.id });
    expect(rows[0]?.title).toBe('You were mentioned in a comment on "Roadmap"');
  });

  it("addPageComment does not notify the author for mentioning themselves", async () => {
    const page = await seedTeamPage("Self");

    await withAuthorizedTenant(ctx, (tx) =>
      addPageComment(tx, { pageId: page.id, blockId: "page", authorId: users.author, bodyJson: mentionBody(users.author, "Author") }),
    );

    expect(await pageMentionNotifications()).toHaveLength(0);
  });

  it("addPageComment does not notify a user outside the page's team", async () => {
    const page = await seedTeamPage("Team A only");

    await withAuthorizedTenant(ctx, (tx) =>
      addPageComment(tx, { pageId: page.id, blockId: "page", authorId: users.author, bodyJson: mentionBody(users.outsider, "Outsider") }),
    );

    expect(await pageMentionNotifications()).toHaveLength(0);
  });

  it("addPageComment does not notify a teammate mentioned on a private page they cannot see", async () => {
    const page = await seedPrivatePage("My private notes");

    await withAuthorizedTenant(ctx, (tx) =>
      addPageComment(tx, { pageId: page.id, blockId: "page", authorId: users.author, bodyJson: mentionBody(users.member, "Member") }),
    );

    expect(await pageMentionNotifications()).toHaveLength(0);
  });

  it("legacy { text } comments store fine and create no page mention notifications", async () => {
    const page = await seedTeamPage("Legacy");

    const { commentId } = await withAuthorizedTenant(ctx, (tx) =>
      addPageComment(tx, { pageId: page.id, blockId: "page", authorId: users.author, bodyJson: { text: "plain old comment" } }),
    );

    const [stored] = await admin.select().from(schema.pageComment).where(eq(schema.pageComment.id, commentId));
    expect(stored?.bodyJson).toEqual({ text: "plain old comment" });
    expect(await pageMentionNotifications()).toHaveLength(0);
  });

  it("notifyPageBodyMention notifies a visible member with the body wording", async () => {
    const page = await seedTeamPage("Design doc");

    await withAuthorizedTenant(ctx, (tx) =>
      notifyPageBodyMention(tx, { organizationId: orgId, pageId: page.id, actorId: users.author, userId: users.member }),
    );

    const rows = await pageMentionNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: users.member, entityType: "page", entityId: page.id });
    expect(rows[0]?.title).toBe('You were mentioned in "Design doc"');
  });

  it("notifyPageBodyMention follows the same visibility rules (no notification for an outsider)", async () => {
    const page = await seedTeamPage("Team A doc");

    await withAuthorizedTenant(ctx, (tx) =>
      notifyPageBodyMention(tx, { organizationId: orgId, pageId: page.id, actorId: users.author, userId: users.outsider }),
    );

    expect(await pageMentionNotifications()).toHaveLength(0);
  });

  it("notifyPageBodyMention does not notify the actor", async () => {
    const page = await seedTeamPage("Own doc");

    await withAuthorizedTenant(ctx, (tx) =>
      notifyPageBodyMention(tx, { organizationId: orgId, pageId: page.id, actorId: users.author, userId: users.author }),
    );

    expect(await pageMentionNotifications()).toHaveLength(0);
  });
});
