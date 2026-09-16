import { useEffect, useRef, useState } from "react";
import { HexColorPicker, HexColorInput } from "react-colorful";
import { useTranslation } from "@kompast/i18n";

/**
 * Theme-variable tokens (not raw hex) so these 6 presets keep adapting to
 * light/dark mode — see packages/ui/src/theme.css. A custom pick below
 * writes a raw #rrggbb hex instead, which won't adapt; an accepted,
 * explicit tradeoff for choosing something outside the theme palette.
 */
export const COLUMN_TONES = ["var(--indigo)", "var(--violet)", "var(--amber)", "var(--green)", "var(--danger)", "var(--text3)"];

const DEFAULT_CUSTOM_COLOR = "#6366f1";

export function ColorSwatchPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const { t } = useTranslation("board");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isCustom = !COLUMN_TONES.includes(value);
  const [draft, setDraft] = useState(isCustom ? value : DEFAULT_CUSTOM_COLOR);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  return (
    <span className="flex items-center gap-1">
      {COLUMN_TONES.map((tone) => (
        <button
          key={tone}
          type="button"
          onClick={() => onChange(tone)}
          title={tone}
          className="h-[15px] w-[15px] flex-none rounded-full"
          style={{ background: tone, boxShadow: value === tone ? "0 0 0 2px var(--border-2)" : undefined }}
        />
      ))}
      <span ref={ref} className="relative">
        <button
          type="button"
          title={t("colorPicker.customTitle")}
          onClick={() => {
            setDraft(isCustom ? value : DEFAULT_CUSTOM_COLOR);
            setOpen((v) => !v);
          }}
          className="h-[15px] w-[15px] flex-none rounded-full border border-border-2"
          style={{
            background: isCustom ? value : "conic-gradient(from 0deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
            boxShadow: isCustom ? "0 0 0 2px var(--border-2)" : undefined,
          }}
        />
        {open && (
          <div className="absolute left-0 top-[22px] z-10 w-[180px] rounded-[10px] border border-border bg-surface p-2.5 shadow-kp">
            <HexColorPicker color={draft} onChange={setDraft} onChangeEnd={onChange} style={{ width: "100%", height: 120 }} />
            <HexColorInput
              color={draft}
              onChange={(hex) => {
                setDraft(hex);
                onChange(hex);
              }}
              prefixed
              className="mt-2 w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1 font-mono text-[12px] outline-none"
            />
          </div>
        )}
      </span>
    </span>
  );
}
