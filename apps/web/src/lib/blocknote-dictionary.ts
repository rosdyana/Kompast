import type { Dictionary } from "@blocknote/core";
import { en, zhTW } from "@blocknote/core/locales";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";

// BlockNote ships no Indonesian dictionary — `id` falls back to English
// for the editor's own chrome (slash menu, toolbar, block placeholders).
const DICTIONARIES: Record<SupportedLocale, Dictionary> = { en, id: en, "zh-Hant": zhTW };

export function useBlockNoteDictionary() {
  const { i18n } = useTranslation();
  const locale = i18n.language as SupportedLocale;
  return { locale, dictionary: DICTIONARIES[locale] ?? en };
}
