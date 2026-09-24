import type { ReactNode } from "react";
import clsx from "clsx";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** "panel" draws a dashed frame; "plain" sits directly on the page. */
  variant?: "panel" | "plain";
}

/**
 * Empty states teach the next step: what this area is for, and the one
 * action that fills it.
 */
export function EmptyState({ icon, title, description, action, className, variant = "panel" }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        "flex flex-col items-center px-6 py-12 text-center",
        variant === "panel" && "rounded-[10px] border border-dashed border-border-2 bg-surface-2",
        className,
      )}
    >
      {icon && <div className="mb-3 grid h-10 w-10 place-items-center rounded-[10px] bg-surface-3 text-text-2">{icon}</div>}
      <p className="type-headline">{title}</p>
      {description && <p className="mt-1 max-w-[420px] type-small text-text-2">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={clsx("inline-block flex-none animate-spin rounded-full border-2 border-border-2 border-t-accent", className)}
      style={{ width: size, height: size }}
    />
  );
}

/** Row-shaped loading placeholder for lists and tables. */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx("flex flex-col gap-2", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="kp-skeleton h-8" style={{ opacity: 1 - i * 0.15 }} />
      ))}
    </div>
  );
}
