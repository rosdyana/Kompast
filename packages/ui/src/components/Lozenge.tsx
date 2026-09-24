import type { HTMLAttributes } from "react";
import clsx from "clsx";

export type StatusCategory = "todo" | "in_progress" | "done";

const CATEGORY_COLOR: Record<StatusCategory, string> = {
  todo: "var(--text2)",
  in_progress: "var(--accent-text)",
  done: "var(--green)",
};

export interface LozengeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "color"> {
  /** A CSS color (DB-stored status/column colors are `var(--x)` strings or hex). */
  color?: string | null;
  /** Falls back to the Jira convention when no explicit color: gray / blue / green. */
  category?: StatusCategory | null;
  /** Bold, uppercase Jira lozenge (default) or a softer sentence-case chip. */
  appearance?: "bold" | "subtle";
}

/**
 * Status lozenge — Jira's most recognizable glyph: a small, tinted,
 * uppercase label whose hue carries the status category at a glance.
 */
export function Lozenge({ color, category, appearance = "bold", className, style, children, ...props }: LozengeProps) {
  const c = color ?? (category ? CATEGORY_COLOR[category] : "var(--text2)");
  return (
    <span
      className={clsx(
        "inline-flex h-5 max-w-full flex-none items-center truncate rounded-[4px] px-1.5 leading-none",
        appearance === "bold" ? "text-[11px] font-bold uppercase tracking-[0.03em]" : "text-[12px] font-medium",
        className,
      )}
      style={{ color: c, backgroundColor: `color-mix(in srgb, ${c} 14%, var(--surface))`, ...style }}
      {...props}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Tiny colored status dot for dense lists and column headers. */
export function StatusDot({ color, size = 8, className }: { color?: string | null; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx("inline-block flex-none rounded-full", className)}
      style={{ width: size, height: size, background: color ?? "var(--text3)" }}
    />
  );
}
