import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Bell, CheckCheck } from "lucide-react";
import { Popover } from "@kompast/ui/Popover";
import { IconButton } from "@kompast/ui/Button";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listNotificationsFn, markNotificationReadFn, markAllNotificationsReadFn } from "@/lib/server-fns/notifications";
import { cn } from "@/lib/cn";

type NotificationsData = Awaited<ReturnType<typeof listNotificationsFn>>;

const POLL_MS = 30_000;

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

function relativeTime(date: Date, locale: string) {
  const diff = (date.getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return date.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

export function NotificationBell() {
  const { t, i18n } = useTranslation("notifications");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const [data, setData] = useState<NotificationsData | null>(null);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  async function refresh() {
    try {
      setData(await listNotificationsFn());
    } catch {
      // transient (network/session) — keep the last known list
    }
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  async function handleOpenNotification(notificationId: string) {
    await markNotificationReadFn({ data: notificationId });
    await refresh();
  }

  async function handleMarkAllRead() {
    await markAllNotificationsReadFn();
    await refresh();
  }

  const unreadCount = data?.unreadCount ?? 0;

  return (
    <>
      <IconButton
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        aria-label={unreadCount > 0 ? `${t("bellTitle")} (${unreadCount})` : t("bellTitle")}
        title={t("bellTitle")}
        className="relative"
      >
        <Bell size={17} strokeWidth={1.75} />
        {unreadCount > 0 && (
          <span className="absolute right-0.5 top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-full border-2 border-bg bg-danger px-[3px] text-[9px] font-bold leading-none text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </IconButton>

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} placement="bottom-end" width={380} ariaLabel={t("bellTitle")}>
        <div className="flex h-11 flex-none items-center justify-between border-b border-border px-4">
          <span className="text-[14px] font-semibold">{t("bellTitle")}</span>
          {unreadCount > 0 && (
            <button onClick={handleMarkAllRead} className="flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[12.5px] text-text-2 hover:bg-surface-3 hover:text-text">
              <CheckCheck size={14} />
              {t("markAllRead")}
            </button>
          )}
        </div>
        <div className="max-h-[420px] min-h-0 overflow-y-auto">
          {!data || data.notifications.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-3 text-text-3">
                <Bell size={18} />
              </span>
              <p className="text-[13.5px] text-text-2">{t("noNotifications")}</p>
            </div>
          ) : (
            data.notifications.map((n) => (
              <button
                key={n.id}
                onClick={() => handleOpenNotification(n.id)}
                className={cn(
                  "relative flex w-full gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-surface-2",
                  !n.readAt && "bg-accent-soft/40",
                )}
              >
                <span className={cn("mt-1.5 h-2 w-2 flex-none rounded-full", n.readAt ? "bg-transparent" : "bg-accent")} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13.5px] font-medium leading-snug text-text">{n.title}</span>
                  {n.body && <span className="line-clamp-2 text-[12.5px] leading-snug text-text-2">{n.body}</span>}
                  <span className="text-[12px] text-text-3">{relativeTime(new Date(n.createdAt), intlLocale)}</span>
                </span>
              </button>
            ))
          )}
        </div>
        <Link
          to="/settings"
          search={{ tab: "notifications" }}
          onClick={() => setOpen(false)}
          className="block flex-none border-t border-border px-4 py-2.5 text-center text-[13px] text-text-2 hover:bg-surface-2 hover:text-text"
        >
          {t("settingsLink")}
        </Link>
      </Popover>
    </>
  );
}
