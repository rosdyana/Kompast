import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { loadFrimousseData, searchEmojis, type FrimousseEmoji, type FrimousseEmojiData } from "@blocknote/core/emoji-data";
import { useTranslation } from "@kompast/i18n";

/**
 * searchEmojis scores "label contains the query" the same for every match, so
 * "fire" put 👨‍🚒 firefighter (people come first in the data) ahead of 🔥 fire —
 * and Enter picks the first result. Rank an exact label match first, then
 * labels starting with the query, keeping searchEmojis' order within each tier.
 */
function rankByLabel(emojis: FrimousseEmoji[], query: string, locale: string): FrimousseEmoji[] {
  const q = query.toLocaleLowerCase(locale);
  const tier = (e: FrimousseEmoji) => {
    const label = e.label.toLocaleLowerCase(locale);
    return label === q ? 0 : label.startsWith(q) ? 1 : 2;
  };
  return emojis.map((e, i) => ({ e, i, t: tier(e) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.e);
}

/** Shown above the full grid, so the common reactions are one click away. */
const QUICK_EMOJI = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"];

/**
 * BlockNote's emoji data ships localized names for these locales only. Indonesian
 * has no entry, so it uses English names (the loader would fall back the same way).
 */
function emojiDataLocale(language: string): string {
  return language === "zh-Hant" ? "zh-hant" : "en";
}

export interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose?: () => void;
}

/**
 * The full emoji picker used by reactions and the editor button. It's mounted
 * only while its Popover is open, so the emoji data is first loaded the first
 * time the picker opens. The data is bundled, so nothing is fetched from a CDN.
 */
export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const { t, i18n } = useTranslation("common");
  const locale = emojiDataLocale(i18n.language);
  const [data, setData] = useState<FrimousseEmojiData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadFrimousseData(locale)
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const labelByEmoji = useMemo(() => new Map((data?.emojis ?? []).map((e) => [e.emoji, e.label])), [data]);
  const trimmed = query.trim();
  const results = useMemo<FrimousseEmoji[]>(() => {
    if (!data) return [];
    return trimmed ? rankByLabel(searchEmojis(data.emojis, trimmed, data.locale), trimmed, data.locale) : data.emojis;
  }, [data, trimmed]);

  /** Grid sections by category, in the data's own order. Searching shows one flat list instead. */
  const sections = useMemo(() => {
    if (!data || trimmed) return [];
    const byCategory = new Map<number, FrimousseEmoji[]>();
    for (const emoji of results) {
      const list = byCategory.get(emoji.category) ?? [];
      list.push(emoji);
      byCategory.set(emoji.category, list);
    }
    return [...data.categories]
      .sort((a, b) => a.index - b.index)
      .map((category) => ({ key: category.index, label: category.label, emojis: byCategory.get(category.index) ?? [] }))
      .filter((section) => section.emojis.length > 0);
  }, [data, results, trimmed]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose?.();
    } else if (e.key === "Enter") {
      // Enter picks the first search result. With no query there is no "first result" to pick.
      const first = results[0];
      if (trimmed && first) {
        e.preventDefault();
        onSelect(first.emoji);
      }
    }
  }

  const noResults = !!data && trimmed.length > 0 && results.length === 0;

  return (
    <div className="flex max-h-[360px] w-[320px] flex-col overflow-y-auto bg-surface p-2 text-text">
      <input
        type="search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("emojiSearch")}
        aria-label={t("emojiSearch")}
        className="sticky top-0 z-10 h-8 w-full rounded-[6px] border border-border-2 bg-surface-2 px-2.5 text-[13px] text-text placeholder:text-text-3 focus:border-accent focus:outline-none focus:shadow-[0_0_0_3px_var(--accent-soft)]"
      />

      <div role="group" aria-label={t("emojiQuick")} className="mt-2 grid grid-cols-8 gap-0.5">
        {QUICK_EMOJI.map((emoji) => (
          <EmojiButton key={emoji} emoji={emoji} label={labelByEmoji.get(emoji) ?? emoji} onSelect={onSelect} />
        ))}
      </div>

      {failed && <p className="px-1 pt-3 text-[13px] text-text-3">{t("emojiNoResults")}</p>}
      {noResults && <p className="px-1 pt-3 text-[13px] text-text-3">{t("emojiNoResults")}</p>}

      {trimmed ? (
        <div className="mt-1 grid grid-cols-8 gap-0.5">
          {results.map((e) => (
            <EmojiButton key={e.emoji} emoji={e.emoji} label={e.label} onSelect={onSelect} />
          ))}
        </div>
      ) : (
        sections.map((section) => (
          <section key={section.key}>
            <h3 className="px-1 pt-2 pb-1 text-[11.5px] font-semibold uppercase tracking-wide text-text-3">{section.label}</h3>
            <div className="grid grid-cols-8 gap-0.5">
              {section.emojis.map((e) => (
                <EmojiButton key={e.emoji} emoji={e.emoji} label={e.label} onSelect={onSelect} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function EmojiButton({ emoji, label, onSelect }: { emoji: string; label: string; onSelect: (emoji: string) => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => onSelect(emoji)}
      className="flex h-8 w-8 items-center justify-center rounded-[6px] text-[20px] leading-none hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent-soft)]"
    >
      {emoji}
    </button>
  );
}
