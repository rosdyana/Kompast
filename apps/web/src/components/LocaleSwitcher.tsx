import { useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ChevronDown, Languages } from "lucide-react";
import { Popover } from "@kompast/ui/Popover";
import { MenuItem, MenuList } from "@kompast/ui/Menu";
import { useTranslation, SUPPORTED_LOCALES, LOCALE_LABELS, type SupportedLocale } from "@kompast/i18n";
import { setLocaleFn } from "@/lib/server-fns/locale";

/** Language picker for signed-out pages (inside the app it lives in the workspace menu). */
export function LocaleSwitcher({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  async function selectLocale(locale: SupportedLocale) {
    setOpen(false);
    await setLocaleFn({ data: { locale } });
    // Re-runs the root loader so the i18n instance and <html lang> update — no reload.
    await router.invalidate();
  }

  const current = i18n.language as SupportedLocale;

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-[13px] text-text-2 hover:bg-surface-3 hover:text-text ${className ?? ""}`}
      >
        <Languages size={15} strokeWidth={1.75} />
        {LOCALE_LABELS[current] ?? current}
        <ChevronDown size={13} className="text-text-3" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} placement="bottom-end" width={200} role="menu">
        <MenuList>
          {SUPPORTED_LOCALES.map((locale) => (
            <MenuItem key={locale} onClick={() => selectLocale(locale)} selected={locale === current}>
              {LOCALE_LABELS[locale]}
            </MenuItem>
          ))}
        </MenuList>
      </Popover>
    </>
  );
}
