import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from "react";
import clsx from "clsx";
import { Check } from "lucide-react";

/** Scrollable list container for use inside <Popover>. */
export function MenuList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="menu" className={clsx("flex min-h-0 flex-col overflow-y-auto p-1", className)}>
      {children}
    </div>
  );
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  /** Right-aligned hint (a shortcut, a count). */
  hint?: ReactNode;
  selected?: boolean;
  danger?: boolean;
  active?: boolean;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(
  ({ icon, hint, selected, danger, active, className, children, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      role="menuitem"
      data-active={active || undefined}
      className={clsx(
        "flex min-h-8 w-full items-center gap-2 rounded-[5px] px-2 py-1 text-left text-[13.5px] outline-none",
        "hover:bg-surface-3 focus-visible:bg-surface-3 data-[active]:bg-surface-3 disabled:pointer-events-none disabled:opacity-50",
        danger ? "text-danger" : "text-text",
        className,
      )}
      {...props}
    >
      {icon !== undefined && <span className="grid w-4 flex-none place-items-center text-text-2">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint !== undefined && <span className="flex-none text-[12px] text-text-3">{hint}</span>}
      {selected && <Check size={15} strokeWidth={2} className="flex-none text-accent" />}
    </button>
  ),
);
MenuItem.displayName = "MenuItem";

export function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px flex-none bg-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-2 type-label-overline text-text-3">{children}</div>;
}
