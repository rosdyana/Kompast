import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { listNotificationsFn, markNotificationReadFn, markAllNotificationsReadFn } from "@/lib/server-fns/notifications";

type NotificationsData = Awaited<ReturnType<typeof listNotificationsFn>>;

const POLL_MS = 30_000;

export function NotificationBell() {
  const [data, setData] = useState<NotificationsData | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  async function refresh() {
    setData(await listNotificationsFn());
  }

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

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
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative grid h-[29px] w-[29px] place-items-center rounded-[7px] border border-border bg-surface text-xs hover:bg-surface-3"
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-[36px] z-50 w-[320px] rounded-[10px] border border-border bg-surface shadow-kp">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[12.5px] font-semibold">Notifikasi</span>
            <button onClick={handleMarkAllRead} className="text-[11px] text-text-3 hover:text-text">
              Tandai semua dibaca
            </button>
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            {!data || data.notifications.length === 0 ? (
              <p className="p-4 text-center text-[12.5px] text-text-3">Tidak ada notifikasi.</p>
            ) : (
              data.notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleOpenNotification(n.id)}
                  className="flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-surface-3"
                  style={{ background: n.readAt ? undefined : "var(--surface-2)" }}
                >
                  <span className="text-[12.5px] font-medium leading-snug">{n.title}</span>
                  {n.body && <span className="truncate text-[11.5px] text-text-3">{n.body}</span>}
                  <span className="font-mono text-[10px] text-text-3">{new Date(n.createdAt).toLocaleString("id-ID")}</span>
                </button>
              ))
            )}
          </div>
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-border px-3 py-2 text-center text-[11.5px] text-text-2 hover:bg-surface-3"
          >
            Pengaturan notifikasi
          </Link>
        </div>
      )}
    </div>
  );
}
