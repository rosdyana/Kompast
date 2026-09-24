import type { ReactNode } from "react";
import clsx from "clsx";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/** Title row for workspace-level pages (settings, tokens, teams, docs index). */
export function PageHeader({ title, subtitle, actions, icon, className }: PageHeaderProps) {
  return (
    <div className={clsx("mb-6 flex flex-wrap items-start gap-x-4 gap-y-3", className)}>
      {icon && <div className="flex-none">{icon}</div>}
      <div className="min-w-0 flex-1">
        <h1 className="type-title">{title}</h1>
        {subtitle && <p className="mt-1 max-w-[680px] type-body text-text-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
