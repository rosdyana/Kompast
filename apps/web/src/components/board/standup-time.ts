/**
 * The "since" boundary for a standup: local midnight of the previous working
 * day. Monday goes back to Friday; Saturday and Sunday also go back to Friday;
 * any other day goes back one day. Computed in the viewer's local timezone
 * on purpose (the server's UTC day would cut the team's day at the wrong hour).
 */
export function previousWorkingDayStart(now: Date): Date {
  const dayOfWeek = now.getDay(); // 0 = Sunday … 6 = Saturday, local
  const daysBack = dayOfWeek === 1 ? 3 : dayOfWeek === 0 ? 2 : 1;
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
}

/** Local calendar date as "YYYY-MM-DD" — used for the sessionStorage draft key and the saved page title. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Milliseconds as "m:ss" (floored to whole seconds, never negative). */
export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Logged work as "1h 30m" / "45m" / "2h" (rounded to whole minutes, at least 1m). */
export function formatWorkTime(seconds: number): string {
  const totalMin = Math.max(1, Math.round(seconds / 60));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
