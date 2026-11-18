import { eq, schema } from "@kompast/db";
import { loadEnv } from "@kompast/env";
import type { Tx } from "./types";
import { canUserSeeEntity } from "./permissions";
import { notifyMentionedUsers } from "./notification";

export interface NotifyPageMentionsInput {
  organizationId: string;
  pageId: string;
  actorId: string;
  userIds: string[];
  /** "comment" for a mention inside a page comment, "body" for one inserted into the doc itself. Only changes the notification title. */
  context: "comment" | "body";
}

/**
 * Notifies @mentioned people about a doc (eventType "page.mentioned").
 * Drops the actor and duplicates, then keeps only users who can see the page
 * for *themselves* — notify() re-checks this too, but the tx's RLS identity is
 * the caller, so this is the place that must not rely on the caller's view.
 * Best-effort on a missing page row: nothing to notify about, so it returns
 * without throwing.
 */
export async function notifyPageMentions(tx: Tx, input: NotifyPageMentionsInput) {
  const candidates = [...new Set(input.userIds)].filter((userId) => !!userId && userId !== input.actorId);
  if (candidates.length === 0) return;

  const [page] = await tx.select({ title: schema.page.title }).from(schema.page).where(eq(schema.page.id, input.pageId));
  if (!page) return;

  const visible: string[] = [];
  for (const userId of candidates) {
    if (await canUserSeeEntity(tx, { organizationId: input.organizationId, userId, entityType: "page", entityId: input.pageId })) visible.push(userId);
  }
  if (visible.length === 0) return;

  const pageTitle = page.title || "Untitled";
  await notifyMentionedUsers(tx, {
    organizationId: input.organizationId,
    entityId: input.pageId,
    entityType: "page",
    mentionedUserIds: visible,
    title: input.context === "comment" ? `You were mentioned in a comment on "${pageTitle}"` : `You were mentioned in "${pageTitle}"`,
    actionUrl: `${loadEnv().APP_URL}/docs/${input.pageId}`,
  });
}

export interface NotifyPageBodyMentionInput {
  organizationId: string;
  pageId: string;
  actorId: string;
  userId: string;
}

/**
 * Called once when someone inserts a person mention into a doc body from the
 * @ menu (Editor.tsx → notifyPageMentionFn). Paste, undo and collab sync do not
 * come through here, so they do not re-notify; see ENGINEERING-NOTES.
 */
export async function notifyPageBodyMention(tx: Tx, input: NotifyPageBodyMentionInput) {
  await notifyPageMentions(tx, {
    organizationId: input.organizationId,
    pageId: input.pageId,
    actorId: input.actorId,
    userIds: [input.userId],
    context: "body",
  });
}
