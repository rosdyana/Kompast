export const SUPPORTED_LOCALES = ["en", "id", "zh-Hant"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: SupportedLocale = "en";
export const NAMESPACES = ["common", "nav", "home"] as const;
export type Namespace = (typeof NAMESPACES)[number];

// Deliberately NOT run through t() — a language picker always shows each
// option in its own language (endonym), regardless of the current UI locale.
export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: "English",
  id: "Bahasa Indonesia",
  "zh-Hant": "繁體中文",
};
