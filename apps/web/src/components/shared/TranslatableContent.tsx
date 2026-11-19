import { useRef, useState, type ReactNode } from "react";
import type { Block } from "@blocknote/core";
import { ChevronDown, Languages, Loader2 } from "lucide-react";
import { SUPPORTED_LOCALES, useTranslation, type SupportedLocale } from "@kompast/i18n";
import { MenuItem, MenuList } from "@kompast/ui/Menu";
import { Popover } from "@kompast/ui/Popover";
import { useToast } from "@kompast/ui/Toast";
import { RichTextView, normalizeToBlocks } from "@/components/shared/RichTextView";
import { LOCALE_LANGUAGE, localeOf, translateContent, translateText } from "@/lib/translate-content";

/** i18n key (issue namespace) for each language's display name. */
export const LANGUAGE_KEYS = {
  en: "languageEnglish",
  id: "languageIndonesian",
  "zh-Hant": "languageTraditionalChinese",
} as const satisfies Record<SupportedLocale, string>;

interface Translated {
  blocks: Block[];
  title: string | null;
}

/**
 * Translation state for one piece of content (and optionally a title shown
 * next to it). Nothing runs until the user clicks; results are cached per
 * target language. The whole state resets when the content or title changes,
 * and a request that finishes after such a change is discarded.
 */
export function useContentTranslation({ content, title }: { content: unknown; title?: string }) {
  const { t, i18n } = useTranslation("issue");
  const toast = useToast();
  const defaultTarget = localeOf(i18n.language);

  const hasBody = normalizeToBlocks(content) !== undefined;
  const hasTitle = !!title?.trim();
  const hasSource = hasBody || hasTitle;
  const resetKey = `${JSON.stringify(content) ?? ""}\u0000${title ?? ""}`;

  type Store = { key: string; view: SupportedLocale | null; cache: Partial<Record<SupportedLocale, Translated>> };
  const [store, setStore] = useState<Store>({ key: resetKey, view: null, cache: {} });
  const [busy, setBusy] = useState<{ key: string; target: SupportedLocale } | null>(null);

  // Stale store if the content changed since the last write: treat as empty.
  const current: Store = store.key === resetKey ? store : { key: resetKey, view: null, cache: {} };
  const busyTarget = busy?.key === resetKey ? busy.target : null;

  const latestKey = useRef(resetKey);
  latestKey.current = resetKey;

  async function translate(target: SupportedLocale) {
    if (!hasSource) return;
    const cached = current.cache[target];
    if (cached) {
      setStore({ ...current, view: target });
      return;
    }
    const key = resetKey;
    setBusy({ key, target });
    try {
      const language = LOCALE_LANGUAGE[target];
      const [blocks, translatedTitle] = await Promise.all([
        hasBody ? translateContent(content, language) : Promise.resolve([] as Block[]),
        hasTitle ? translateText(title!.trim(), language) : Promise.resolve(null),
      ]);
      if (latestKey.current !== key) return;
      setStore((s) => {
        const base = s.key === key ? s : { key, view: null, cache: {} };
        return { key, view: target, cache: { ...base.cache, [target]: { blocks, title: translatedTitle } } };
      });
    } catch (err) {
      if (latestKey.current === key) {
        toast.show({ title: t("translateFailed", { message: err instanceof Error ? err.message : String(err) }), tone: "error" });
      }
    } finally {
      setBusy((b) => (b && b.key === key && b.target === target ? null : b));
    }
  }

  function showOriginal() {
    setStore({ key: resetKey, view: null, cache: current.cache });
  }

  const translated = current.view ? current.cache[current.view] : undefined;

  return {
    hasSource,
    defaultTarget,
    /** The language currently shown, or null for the original. */
    view: current.view,
    busy: busyTarget,
    translated,
    translatedTitle: translated?.title ?? null,
    translate,
    showOriginal,
  };
}

export type ContentTranslation = ReturnType<typeof useContentTranslation>;

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/**
 * A menu of languages, anchored to its trigger. Portaled, so its clicks bubble
 * through React ancestors: callers render it inside a stop-propagation wrapper.
 */
export function LanguageMenu({
  languages,
  onPick,
  disabled,
  className,
  ariaLabel,
  children,
}: {
  languages: readonly SupportedLocale[];
  onPick: (locale: SupportedLocale) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("issue");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={className}
      >
        {children}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} placement="bottom-start" width={200} role="menu">
        <MenuList>
          {languages.map((locale) => (
            <MenuItem
              key={locale}
              onClick={() => {
                setOpen(false);
                onPick(locale);
              }}
            >
              {t(LANGUAGE_KEYS[locale])}
            </MenuItem>
          ))}
        </MenuList>
      </Popover>
    </>
  );
}

/** Renders the content: the original, or the translation when one is shown. */
export function TranslationView({ tr, content, className }: { tr: ContentTranslation; content: unknown; className?: string }) {
  if (!tr.translated) return <RichTextView content={content} className={className} />;
  // Stop clicks here too: a click on translated text must not open the editor on the original.
  return (
    <div onClick={stop} onKeyDown={stop}>
      <RichTextView content={tr.translated.blocks} className={className} />
    </div>
  );
}

/**
 * The Translate control, with a "Translated to X · Show original" line when a
 * translation is shown. Stops click and keydown propagation: it sits inside
 * click-to-edit containers, and a menu item is portaled but still bubbles.
 */
export function TranslationBar({ tr, className }: { tr: ContentTranslation; className?: string }) {
  const { t } = useTranslation("issue");
  if (!tr.hasSource) return null;
  const shownLanguage = tr.view ?? tr.defaultTarget;
  const others = SUPPORTED_LOCALES.filter((l) => l !== shownLanguage);
  const ghost =
    "inline-flex h-6 items-center gap-1 rounded-[4px] px-1.5 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-text disabled:opacity-60";

  return (
    <div className={`flex flex-wrap items-center gap-1 text-[12.5px] text-text-3 ${className ?? ""}`} onClick={stop} onKeyDown={stop}>
      {tr.view ? (
        <>
          <span>{t("translatedTo", { language: t(LANGUAGE_KEYS[tr.view]) })}</span>
          <button type="button" onClick={tr.showOriginal} className={ghost}>
            {t("showOriginal")}
          </button>
        </>
      ) : tr.busy ? (
        <button type="button" disabled className={ghost}>
          <Loader2 size={13} className="animate-spin" />
          {t("translating")}
        </button>
      ) : (
        <button type="button" onClick={() => tr.translate(tr.defaultTarget)} className={ghost}>
          <Languages size={13} />
          {t("translate")}
        </button>
      )}
      {others.length > 0 && (
        <LanguageMenu
          languages={others}
          onPick={tr.translate}
          disabled={tr.busy !== null}
          ariaLabel={t("translate")}
          className="inline-flex h-6 w-6 items-center justify-center rounded-[4px] text-text-3 hover:bg-surface-3 hover:text-text disabled:opacity-60"
        >
          <ChevronDown size={13} />
        </LanguageMenu>
      )}
    </div>
  );
}

/** Self-contained translate control for a single rich-text value (used for comments). */
export function TranslatableContent({ content, className }: { content: unknown; className?: string }) {
  const tr = useContentTranslation({ content });
  return (
    <>
      <TranslationView tr={tr} content={content} className={className} />
      <TranslationBar tr={tr} className="mt-1" />
    </>
  );
}
