import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequestHeader, setCookie } from "@tanstack/react-start/server";
import * as z from "zod";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type SupportedLocale } from "@kompast/i18n";

const LOCALE_COOKIE = "kompast-locale";

function isSupportedLocale(v: string | undefined): v is SupportedLocale {
  return !!v && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

function localeFromAcceptLanguage(header: string | undefined): SupportedLocale | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const tag = part.split(";")[0]!.trim();
    if (isSupportedLocale(tag)) return tag;
    const primary = tag.split("-")[0]!;
    if (primary === "zh") return "zh-Hant"; // we ship Traditional only; treat any zh-* as zh-Hant
    if (isSupportedLocale(primary)) return primary as SupportedLocale;
  }
  return null;
}

/**
 * SSR-safe locale resolution: cookie wins, then Accept-Language, then
 * default. Unlike theme (packages/ui/src/theme.tsx), no pre-hydration
 * script is needed — on the very first request ever, the server already
 * has everything it needs (Accept-Language) to render fully-translated
 * HTML before any bytes reach the browser.
 */
export const getRequestLocaleFn = createServerFn({ method: "GET" }).handler(() => {
  const cookieValue = getCookie(LOCALE_COOKIE);
  if (isSupportedLocale(cookieValue)) return cookieValue;
  return localeFromAcceptLanguage(getRequestHeader("accept-language")) ?? DEFAULT_LOCALE;
});

const setLocaleSchema = z.object({ locale: z.enum(SUPPORTED_LOCALES) });

export const setLocaleFn = createServerFn({ method: "POST" })
  .validator(setLocaleSchema)
  .handler(async ({ data }) => {
    setCookie(LOCALE_COOKIE, data.locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
    return { ok: true } as const;
  });
