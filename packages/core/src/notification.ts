import { and, desc, eq, isNull, schema } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";
import { enqueueEmail } from "./email";

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
  { eventType: "issue.assigned", label: "Ditugaskan ke tiket" },
  { eventType: "issue.commented", label: "Komentar baru di tiket" },
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

export async function listNotifications(tx: Tx, organizationId: string, userId: string, limit = 50) {
  return tx
    .select()
    .from(schema.notification)
    .where(and(eq(schema.notification.organizationId, organizationId), eq(schema.notification.userId, userId)))
    .orderBy(desc(schema.notification.createdAt))
    .limit(limit);
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
