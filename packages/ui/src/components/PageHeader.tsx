import type { ReactNode } from "react";
import clsx from "clsx";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * The title+subtitle pattern repeated (identically) across every non-hero
 * page — settings, notifications, tokens, teams. Not used by the dashboard,
 * whose serif "welcome" headline is a deliberate hero moment, not this
 * pattern's drift.
 */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div className={clsx(subtitle ? "mb-8" : "mb-6", className)}>
      <div className={clsx("flex items-start justify-between gap-4", subtitle ? "mb-1" : "")}>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {actions}
      </div>
      {subtitle && <p className="text-sm text-text-2">{subtitle}</p>}
    </div>
  );
}
