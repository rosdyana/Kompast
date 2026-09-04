import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import {
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  listNotificationPrefs,
  setNotificationPref,
  NOTIFICATION_EVENT_TYPES,
  withAuthorizedTenant,
} from "@kompast/core";
import { requireAuthContext } from "../session";

export const listNotificationsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  const [notifications, unreadCount] = await withAuthorizedTenant(ctx, async (tx) => [
    await listNotifications(tx, ctx.organizationId, ctx.userId),
    await countUnreadNotifications(tx, ctx.organizationId, ctx.userId),
  ]);
  return { notifications, unreadCount };
});

export const markNotificationReadFn = createServerFn({ method: "POST" })
  .validator((notificationId: string) => notificationId)
  .handler(async ({ data: notificationId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => markNotificationRead(tx, notificationId, ctx.userId));
    return { ok: true } as const;
  });

export const markAllNotificationsReadFn = createServerFn({ method: "POST" }).handler(async () => {
  const ctx = await requireAuthContext();
  await withAuthorizedTenant(ctx, (tx) => markAllNotificationsRead(tx, ctx.organizationId, ctx.userId));
  return { ok: true } as const;
});

export const listNotificationPrefsFn = createServerFn({ method: "GET" }).handler(async () => {
  const ctx = await requireAuthContext();
  const rows = await withAuthorizedTenant(ctx, (tx) => listNotificationPrefs(tx, ctx.organizationId, ctx.userId));
  const byEventType = new Map(rows.map((r) => [r.eventType, r]));
  return NOTIFICATION_EVENT_TYPES.map(({ eventType, label }) => {
    const row = byEventType.get(eventType);
    return { eventType, label, inApp: row?.inApp ?? true, email: row?.email ?? true, digest: row?.digest ?? "instant" };
  });
});

const setPrefSchema = z.object({
  eventType: z.string(),
  inApp: z.boolean().optional(),
  email: z.boolean().optional(),
  digest: z.enum(["instant", "hourly", "daily", "off"]).optional(),
});

export const setNotificationPrefFn = createServerFn({ method: "POST" })
  .validator(setPrefSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) =>
      setNotificationPref(tx, { organizationId: ctx.organizationId, userId: ctx.userId, eventType: data.eventType, inApp: data.inApp, email: data.email, digest: data.digest }),
    );
    return { ok: true } as const;
  });
