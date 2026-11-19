import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminDb, db, eq, schema } from "@kompast/db";
import { withAuthorizedTenant, type AuthContext } from "../permissions";
import { renameThread, deleteThread } from "../rag";
import { NotFoundError, UserFacingError } from "../errors";
import { id } from "../ids";

/**
 * Rename / delete for Ask Kompast threads. Only the thread's owner may change it; another member of the same
 * workspace must get NotFound and leave the row untouched (RLS hides other users' threads). Everything here is
 * scoped to this file's own ids.
 */
describe("ask threads (rename / delete)", () => {
  const orgId = "test-ask-threads-org";
  const ownerId = "test-ask-threads-owner";
  const otherId = "test-ask-threads-other";
  const ownerCtx: AuthContext = { userId: ownerId, organizationId: orgId };
  const otherCtx: AuthContext = { userId: otherId, organizationId: orgId };
  // A fixed past timestamp so "updatedAt unchanged" is a real comparison, not a same-millisecond coincidence.
  const OLD_UPDATED_AT = new Date("2020-01-02T03:04:05.000Z");

  async function cleanup() {
    // Deleting the thread cascades to its messages.
    await db.delete(schema.aiThread).where(eq(schema.aiThread.organizationId, orgId));
    await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    for (const uid of [ownerId, otherId]) await db.delete(schema.user).where(eq(schema.user.id, uid));
  }

  beforeEach(async () => {
    await cleanup();
    await db.insert(schema.organization).values({ id: orgId, name: "Ask Threads Org", slug: orgId });
    await db.insert(schema.user).values([
      { id: ownerId, name: "Ask Threads Owner", email: `${ownerId}@example.com` },
      { id: otherId, name: "Ask Threads Other", email: `${otherId}@example.com` },
    ]);
    await db.insert(schema.member).values([
      { id: id("mem"), organizationId: orgId, userId: ownerId, role: "member" },
      { id: id("mem"), organizationId: orgId, userId: otherId, role: "member" },
    ]);
  });

  afterEach(async () => {
    await cleanup();
  });

  /** Creates a thread owned by `owner` with one message, the way askKompast leaves a finished thread. */
  async function seedThread(owner: AuthContext, title: string | null = "Original title") {
    const threadId = id("thread");
    const messageId = id("msg");
    await withAuthorizedTenant(owner, async (tx) => {
      await tx.insert(schema.aiThread).values({ id: threadId, organizationId: orgId, userId: owner.userId, title, updatedAt: OLD_UPDATED_AT });
      await tx.insert(schema.aiMessage).values({ id: messageId, threadId, role: "user", content: "hello" });
    });
    return { threadId, messageId };
  }

  /** Reads through the admin connection so the assertion sees the row regardless of RLS. */
  async function storedThread(threadId: string) {
    const [row] = await adminDb.select().from(schema.aiThread).where(eq(schema.aiThread.id, threadId));
    return row;
  }

  async function storedMessages(threadId: string) {
    return adminDb.select().from(schema.aiMessage).where(eq(schema.aiMessage.threadId, threadId));
  }

  describe("renameThread", () => {
    it("updates the title and leaves updatedAt alone", async () => {
      const { threadId } = await seedThread(ownerCtx);

      await withAuthorizedTenant(ownerCtx, (tx) => renameThread(tx, ownerId, { threadId, title: "  Sprint 4 risks  " }));

      const row = await storedThread(threadId);
      expect(row!.title).toBe("Sprint 4 risks");
      expect(row!.updatedAt.getTime()).toBe(OLD_UPDATED_AT.getTime());
    });

    it("truncates titles to 200 characters", async () => {
      const { threadId } = await seedThread(ownerCtx);

      await withAuthorizedTenant(ownerCtx, (tx) => renameThread(tx, ownerId, { threadId, title: "x".repeat(250) }));

      expect((await storedThread(threadId))!.title).toHaveLength(200);
    });

    it("rejects an empty or whitespace-only title and keeps the old one", async () => {
      const { threadId } = await seedThread(ownerCtx);

      await expect(withAuthorizedTenant(ownerCtx, (tx) => renameThread(tx, ownerId, { threadId, title: "   " }))).rejects.toBeInstanceOf(UserFacingError);

      expect((await storedThread(threadId))!.title).toBe("Original title");
    });

    it("throws NotFound when another member of the workspace tries to rename the thread, and leaves it intact", async () => {
      const { threadId } = await seedThread(ownerCtx);

      await expect(withAuthorizedTenant(otherCtx, (tx) => renameThread(tx, otherId, { threadId, title: "Hijacked" }))).rejects.toBeInstanceOf(NotFoundError);

      const row = await storedThread(threadId);
      expect(row!.title).toBe("Original title");
      expect(row!.updatedAt.getTime()).toBe(OLD_UPDATED_AT.getTime());
    });
  });

  describe("deleteThread", () => {
    it("deletes the thread and its messages", async () => {
      const { threadId, messageId } = await seedThread(ownerCtx);

      await withAuthorizedTenant(ownerCtx, (tx) => deleteThread(tx, ownerId, threadId));

      expect(await storedThread(threadId)).toBeUndefined();
      expect(await storedMessages(threadId)).toEqual([]);
      const [orphan] = await adminDb.select().from(schema.aiMessage).where(eq(schema.aiMessage.id, messageId));
      expect(orphan).toBeUndefined();
    });

    it("throws NotFound when another member of the workspace tries to delete the thread, and keeps the thread and its messages", async () => {
      const { threadId } = await seedThread(ownerCtx);

      await expect(withAuthorizedTenant(otherCtx, (tx) => deleteThread(tx, otherId, threadId))).rejects.toBeInstanceOf(NotFoundError);

      expect(await storedThread(threadId)).toBeDefined();
      expect(await storedMessages(threadId)).toHaveLength(1);
    });
  });
});
