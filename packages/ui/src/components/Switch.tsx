import type { ReactNode } from "react";
import clsx from "clsx";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  /** Keep the label for assistive tech but hide it visually (table cells, toolbars). */
  srOnlyLabel?: boolean;
  className?: string;
}

/**
 * On/off toggle. A native checkbox with role="switch" underneath, so
 * keyboard, form and screen-reader behavior come for free. The knob is the
 * surface color, not pure white, per the Comfortable Contrast rule.
 */
export function Switch({ checked, onChange, label, disabled, srOnlyLabel, className }: SwitchProps) {
  return (
    <label
      className={clsx(
        "inline-flex flex-none cursor-pointer select-none items-center gap-2.5 text-[14px] text-text",
        disabled && "cursor-default opacity-50",
        className,
      )}
    >
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className="relative h-5 w-9 flex-none rounded-full bg-surface-4 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-surface after:shadow-card after:transition-transform peer-checked:bg-accent peer-checked:after:translate-x-4 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
      />
      <span className={clsx(srOnlyLabel && "sr-only")}>{label}</span>
    </label>
  );
}
