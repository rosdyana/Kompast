import type { HTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

export type BadgeTone = "neutral" | "accent" | "indigo" | "green" | "amber" | "violet" | "danger";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-text-2",
  accent: "bg-accent-soft text-accent-text",
  indigo: "bg-indigo-soft text-indigo",
  green: "bg-green-soft text-green",
  amber: "bg-amber-soft text-amber",
  violet: "bg-violet-soft text-violet",
  danger: "bg-danger-soft text-danger",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/** Small rounded tag — counts, roles, "Template", "Dry run". */
export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 flex-none items-center gap-1 whitespace-nowrap rounded-[4px] px-1.5 text-[11.5px] font-medium leading-none",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Round numeric counter (sidebar/tab counts). */
export function CountPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold tabular-nums leading-none text-text-2",
        className,
      )}
    >
      {children}
    </span>
  );
}
