import type { ReactNode } from "react";
import clsx from "clsx";

export interface TabItem {
  key: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
  /** "underline" (default, Jira nav) or "pill" (segmented, for sub-views). */
  variant?: "underline" | "pill";
}

export function Tabs({ items, active, onChange, className, variant = "underline" }: TabsProps) {
  if (variant === "pill") {
    return (
      <div role="tablist" className={clsx("inline-flex flex-none items-center gap-0.5 rounded-[7px] bg-surface-3 p-0.5", className)}>
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <button
              key={item.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(item.key)}
              className={clsx(
                "flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 text-[13px] font-medium transition-colors",
                isActive ? "bg-surface text-text shadow-card" : "text-text-2 hover:text-text",
              )}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div role="tablist" className={clsx("flex gap-1 overflow-x-auto", className)}>
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(item.key)}
            className={clsx(
              "relative flex h-9 flex-none items-center gap-1.5 whitespace-nowrap rounded-t-[4px] px-2.5 text-[14px] transition-colors",
              "after:absolute after:inset-x-1.5 after:-bottom-px after:h-[2px] after:rounded-full",
              isActive
                ? "font-medium text-accent-text after:bg-accent"
                : "text-text-2 after:bg-transparent hover:bg-surface-3 hover:text-text",
            )}
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && (
              <span className="rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold tabular-nums text-text-2">{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
