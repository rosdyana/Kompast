import { useRef, useState } from "react";
import { HexColorPicker, HexColorInput } from "react-colorful";
import { Check, ChevronDown } from "lucide-react";
import { Popover } from "@kompast/ui/Popover";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";

/**
 * Theme-variable tokens (not raw hex) so these presets keep adapting to
 * light/dark mode — see packages/ui/src/theme.css. A custom pick writes a
 * raw #rrggbb hex instead, which won't adapt; an accepted, explicit
 * tradeoff for choosing something outside the theme palette.
 */
export const COLUMN_TONES = ["var(--indigo)", "var(--accent)", "var(--violet)", "var(--amber)", "var(--green)", "var(--danger)", "var(--text3)"];

const DEFAULT_CUSTOM_COLOR = "#5b6ee1";

/** One swatch button showing the current color; presets + a custom picker in a popover. */
export function ColorSwatchPicker({ value, onChange, label }: { value: string; onChange: (color: string) => void; label?: string }) {
  const { t } = useTranslation("board");
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const isCustom = !COLUMN_TONES.includes(value);
  const [draft, setDraft] = useState(isCustom ? value : DEFAULT_CUSTOM_COLOR);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={label ?? t("colorPicker.chooseColor")}
        title={label ?? t("colorPicker.chooseColor")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setDraft(isCustom ? value : DEFAULT_CUSTOM_COLOR);
          setOpen((v) => !v);
        }}
        className="inline-flex h-7 flex-none items-center gap-1 rounded-[6px] border border-border-2 bg-surface px-1.5 hover:border-text-3"
      >
        <span className="h-4 w-4 rounded-[4px]" style={{ background: value }} />
        <ChevronDown size={12} strokeWidth={2} className="text-text-3" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} width={216} ariaLabel={t("colorPicker.chooseColor")}>
        <div className="flex flex-col gap-2.5 p-2.5">
          <div className="grid grid-cols-7 gap-1.5">
            {COLUMN_TONES.map((tone) => (
              <button
                key={tone}
                type="button"
                onClick={() => {
                  onChange(tone);
                  setOpen(false);
                }}
                aria-label={tone.replace(/var\(--|\)/g, "")}
                className={cn("grid h-6 w-6 place-items-center rounded-[5px] text-white ring-offset-2 ring-offset-surface", value === tone && "ring-2 ring-text-3")}
                style={{ background: tone }}
              >
                {value === tone && <Check size={13} strokeWidth={3} />}
              </button>
            ))}
          </div>
          <div className="border-t border-border pt-2.5">
            <p className="mb-1.5 text-[12px] font-medium text-text-3">{t("colorPicker.customTitle")}</p>
            <HexColorPicker color={draft} onChange={setDraft} onChangeEnd={onChange} style={{ width: "100%", height: 120 }} />
            <HexColorInput
              color={draft}
              aria-label={t("colorPicker.hexLabel")}
              onChange={(hex) => {
                setDraft(hex);
                onChange(hex);
              }}
              prefixed
              className="kp-field mt-2 w-full font-mono text-[12.5px]"
            />
          </div>
        </div>
      </Popover>
    </>
  );
}
