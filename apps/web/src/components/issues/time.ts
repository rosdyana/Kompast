import type { SupportedLocale } from "@kompast/i18n";

export const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

export function intlLocaleOf(language: string) {
  return INTL_LOCALE[language as SupportedLocale] ?? "en-US";
}

/** "3 minutes ago", "yesterday", or a short date past a week. */
export function relativeTime(value: string | Date, locale: string) {
  const date = new Date(value);
  const diff = (date.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function fullDateTime(value: string | Date, locale: string) {
  return new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function shortDate(value: string | Date, locale: string) {
  return new Date(value).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

/** yyyy-mm-dd for <input type="date">, in UTC to match how dates are stored (midnight UTC). */
export function toDateInput(value: string | Date | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
