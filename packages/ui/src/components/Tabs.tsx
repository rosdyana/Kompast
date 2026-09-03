import type { ReactNode } from "react";
import clsx from "clsx";

export interface TabItem {
  key: string;
  label: string;
  icon?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ items, active, onChange, className }: TabsProps) {
  return (
    <div className={clsx("flex gap-0.5", className)}>
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            className={clsx(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] transition-colors",
              isActive
                ? "border-text font-semibold text-text"
                : "border-transparent font-medium text-text-2 hover:text-text",
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
