import type { HTMLAttributes } from "react";
import clsx from "clsx";

export type BadgeTone = "neutral" | "accent" | "indigo" | "green" | "amber" | "violet";

const tones: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-text-3",
  accent: "bg-accent-soft text-accent",
  indigo: "bg-indigo-soft text-indigo",
  green: "bg-green-soft text-green",
  amber: "bg-amber-soft text-amber",
  violet: "bg-violet-soft text-violet",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
