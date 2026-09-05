import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation, SUPPORTED_LOCALES, LOCALE_LABELS, type SupportedLocale } from "@kompast/i18n";
import { setLocaleFn } from "@/lib/server-fns/locale";

export function LocaleSwitcher() {
  const { i18n } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function selectLocale(locale: SupportedLocale) {
    setOpen(false);
    await setLocaleFn({ data: { locale } });
    // Re-runs the root loader (a cheap, cookie-only read) so RootComponent's
    // i18n instance and <html lang> both update from the new locale — no
    // window.location.reload(), same router.invalidate()-after-mutation
    // pattern already used elsewhere (e.g. _app/settings.tsx).
    await router.invalidate();
  }

  const current = i18n.language as SupportedLocale;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="grid h-[29px] place-items-center rounded-[7px] border border-border bg-surface px-2 text-[11px] hover:bg-surface-3"
      >
        {LOCALE_LABELS[current] ?? current}
      </button>
      {open && (
        <div className="absolute right-0 top-[36px] z-50 w-[180px] rounded-[10px] border border-border bg-surface shadow-kp">
          {SUPPORTED_LOCALES.map((locale) => (
            <button
              key={locale}
              onClick={() => selectLocale(locale)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-[12.5px] hover:bg-surface-3"
            >
              {LOCALE_LABELS[locale]}
              {locale === current && <span className="text-accent">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
