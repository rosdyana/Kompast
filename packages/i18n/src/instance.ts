import i18next, { type i18n as I18nInstance } from "i18next";
import { resources } from "./resources";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, NAMESPACES, type SupportedLocale } from "./config";

/**
 * Resources are bundled statically (no HTTP backend), so init() completes
 * synchronously in practice even though its return type is a Promise —
 * callers deliberately don't await it (can't, inside component render).
 *
 * A fresh instance per call, NOT a module-level singleton: Nitro's
 * node-server preset handles concurrent requests in one process, and a
 * shared i18next instance would leak one request's language into another's
 * response. On the client this is harmless too — it's called once per
 * hydration and again only when the locale switcher forces a recompute.
 */
export function createI18nInstance(locale: SupportedLocale): I18nInstance {
  const instance = i18next.createInstance();
  // No .use(initReactI18next) — this app has its own minimal React binding
  // (./react.tsx) instead of react-i18next's, so there's no react-specific
  // plugin to register here; this instance is plain, framework-agnostic i18next.
  instance.init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    ns: NAMESPACES as unknown as string[],
    defaultNS: "common",
    resources,
    interpolation: { escapeValue: false }, // React already escapes output
  });
  return instance;
}
