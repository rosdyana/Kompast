import { and, desc, eq, inArray, isNull, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { enqueueEmail } from "./email";
import { canUserSeeEntity } from "./permissions";

export interface NotificationPrefView {
  inApp: boolean;
  email: boolean;
  digest: "instant" | "hourly" | "daily" | "off";
}

/**
 * Every event type notify() is actually called with, so the preferences UI
 * has a fixed list to render toggles for instead of only ever showing
 * whatever a user has already customized. Add to this whenever a new
 * notify() call site is added elsewhere — nothing enforces the two stay in
 * sync (there's no compile-time link between an eventType string literal
 * at a call site and this registry), so a new event type silently missing
 * here just means users can't customize it yet, not a crash.
 */
export const NOTIFICATION_EVENT_TYPES = [
  { eventType: "issue.assigned", label: "Assigned to an issue" },
  { eventType: "issue.commented", label: "New comment on an issue you follow" },
  { eventType: "issue.mentioned", label: "Mentioned in an issue" },
  { eventType: "page.shared", label: "A private page was shared with you" },
] as const;

const DEFAULT_PREF: NotificationPrefView = { inApp: true, email: true, digest: "instant" };

/** No row yet means "use the defaults" — a user shouldn't have to visit settings before notifications work at all. */
export async function getNotificationPref(tx: Tx, organizationId: string, userId: string, eventType: string): Promise<NotificationPrefView> {
  const [row] = await tx
    .select()
    .from(schema.notificationPref)
    .where(and(eq(schema.notificationPref.organizationId, organizationId), eq(schema.notificationPref.userId, userId), eq(schema.notificationPref.eventType, eventType)));
  if (!row) return DEFAULT_PREF;
  return { inApp: row.inApp, email: row.email, digest: row.digest };
}

export async function listNotificationPrefs(tx: Tx, organizationId: string, userId: string) {
  return tx.select().from(schema.notificationPref).where(and(eq(schema.notificationPref.organizationId, organizationId), eq(schema.notificationPref.userId, userId)));
}

export interface SetNotificationPrefInput {
  organizationId: string;
  userId: string;
  eventType: string;
  inApp?: boolean;
  email?: boolean;
  digest?: "instant" | "hourly" | "daily" | "off";
}

export async function setNotificationPref(tx: Tx, input: SetNotificationPrefInput) {
  const current = await getNotificationPref(tx, input.organizationId, input.userId, input.eventType);
  const next = {
    inApp: input.inApp ?? current.inApp,
    email: input.email ?? current.email,
    digest: input.digest ?? current.digest,
  };
  await tx
    .insert(schema.notificationPref)
    .values({ id: id("ntfpref"), organizationId: input.organizationId, userId: input.userId, eventType: input.eventType, ...next })
    .onConflictDoUpdate({
      target: [schema.notificationPref.organizationId, schema.notificationPref.userId, schema.notificationPref.eventType],
      set: next,
    });
}

export interface NotifyInput {
  organizationId: string;
  userId: string;
  eventType: string;
  entityType: "issue" | "page";
  entityId: string;
  title: string;
  body?: string;
  /**
   * Only "instant" digest actually sends here — hourly/daily batching is a
   * worker cron job that doesn't exist yet (see README); rows for those
   * preferences are simply not emailed by notify() itself. Always rendered
   * through @kompast/mail's one NotificationEmail template (title/body come
   * from the fields above) — there's no per-eventType template registry to
   * keep in sync, by design, until a second template is actually needed.
   */
  email?: { to: string; actionUrl: string; actionLabel: string };
}

/**
 * The single call site for "something happened, tell this user" — reads
 * their preference for eventType and (a) writes an in-app notification row
 * if inApp is on, (b) enqueues an email if email is on AND digest is
 * "instant" AND the caller passed an `email` payload. Always call this
 * inside the SAME transaction as the mutation that triggered it (same
 * reasoning as enqueueEmail).
 */
export async function notify(tx: Tx, input: NotifyInput): Promise<{ notificationId: string | null; emailQueued: boolean }> {
  // A watcher/assignee who has since left the issue's team (or a mention of
  // someone outside it) must not get the title in their inbox or by email —
  // that would leak exactly what team-scoped RLS hides (M5 in the
  // team-visibility spec). Checked here, at the one place every
  // notification passes through, rather than at each caller.
  if (!(await canUserSeeEntity(tx, { organizationId: input.organizationId, userId: input.userId, entityType: input.entityType, entityId: input.entityId }))) {
    return { notificationId: null, emailQueued: false };
  }
  const pref = await getNotificationPref(tx, input.organizationId, input.userId, input.eventType);

  let notificationId: string | null = null;
  if (pref.inApp) {
    notificationId = id("ntf");
    await tx.insert(schema.notification).values({
      id: notificationId,
      organizationId: input.organizationId,
      userId: input.userId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      title: input.title,
      body: input.body,
    });
  }

  let emailQueued = false;
  if (pref.email && pref.digest === "instant" && input.email) {
    await enqueueEmail(tx, {
      organizationId: input.organizationId,
      to: input.email.to,
      subject: input.title,
      templateKey: "notification",
      templateProps: { title: input.title, body: input.body ?? null, actionUrl: input.email.actionUrl, actionLabel: input.email.actionLabel },
      dedupeKey: notificationId ? `notification:${notificationId}` : `${input.eventType}:${input.entityType}:${input.entityId}:${input.userId}`,
    });
    emailQueued = true;
  }

  return { notificationId, emailQueued };
}

export interface NotifyMentionedUsersInput {
  organizationId: string;
  entityId: string;
  mentionedUserIds: string[];
  title: string;
  body?: string;
  actionUrl: string;
}

/**
 * One `notify()` call per @mentioned user with eventType "issue.mentioned".
 * Callers (addComment, updateIssue) are responsible for filtering out the
 * author and anyone already notified for the same event through another
 * path (e.g. the assignee/reporter on a new comment) before calling this,
 * so a person never gets two notifications for one action.
 */
export async function notifyMentionedUsers(tx: Tx, input: NotifyMentionedUsersInput) {
  if (input.mentionedUserIds.length === 0) return;
  const users = await tx.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(inArray(schema.user.id, input.mentionedUserIds));
  const emailByUserId = new Map(users.map((u) => [u.id, u.email]));
  for (const userId of input.mentionedUserIds) {
    const email = emailByUserId.get(userId);
    await notify(tx, {
      organizationId: input.organizationId,
      userId,
      eventType: "issue.mentioned",
      entityType: "issue",
      entityId: input.entityId,
      title: input.title,
      body: input.body,
      email: email ? { to: email, actionUrl: input.actionUrl, actionLabel: "View issue" } : undefined,
    });
  }
}

export type NotificationTarget =
  | { kind: "issue"; teamId: string | null; projectKey: string; keySeq: number }
  | { kind: "page"; pageId: string };

/**
 * Each row carries a resolved `target` so the bell can link straight to the
 * issue/page. Issue targets are looked up under the caller's RLS identity —
 * an issue the user can no longer see (team change, deletion) resolves to
 * `null` and the row renders as non-navigable instead of a dead link.
 */
export async function listNotifications(tx: Tx, organizationId: string, userId: string, limit = 50) {
  const rows = await tx
    .select()
    .from(schema.notification)
    .where(and(eq(schema.notification.organizationId, organizationId), eq(schema.notification.userId, userId)))
    .orderBy(desc(schema.notification.createdAt))
    .limit(limit);

  const issueIds = [...new Set(rows.filter((r) => r.entityType === "issue").map((r) => r.entityId))];
  const issues = issueIds.length
    ? await tx
        .select({ id: schema.issue.id, keySeq: schema.issue.keySeq, projectKey: schema.project.key, teamId: schema.project.teamId })
        .from(schema.issue)
        .innerJoin(schema.project, eq(schema.project.id, schema.issue.projectId))
        .where(inArray(schema.issue.id, issueIds))
    : [];
  const issueById = new Map(issues.map((i) => [i.id, i]));

  return rows.map((r) => {
    let target: NotificationTarget | null = null;
    if (r.entityType === "page") target = { kind: "page", pageId: r.entityId };
    else {
      const i = issueById.get(r.entityId);
      if (i) target = { kind: "issue", teamId: i.teamId, projectKey: i.projectKey, keySeq: i.keySeq };
    }
    return { ...r, target };
  });
}

export async function countUnreadNotifications(tx: Tx, organizationId: string, userId: string) {
  const rows = await tx
    .select({ id: schema.notification.id })
    .from(schema.notification)
    .where(and(eq(schema.notification.organizationId, organizationId), eq(schema.notification.userId, userId), isNull(schema.notification.readAt)));
  return rows.length;
}

export async function markNotificationRead(tx: Tx, notificationId: string, userId: string) {
  await tx.update(schema.notification).set({ readAt: new Date() }).where(and(eq(schema.notification.id, notificationId), eq(schema.notification.userId, userId)));
}

export async function markAllNotificationsRead(tx: Tx, organizationId: string, userId: string) {
  await tx
    .update(schema.notification)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notification.organizationId, organizationId), eq(schema.notification.userId, userId), isNull(schema.notification.readAt)));
}
