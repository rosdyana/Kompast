import type { ReactNode } from "react";
import clsx from "clsx";

/** Keyboard key hint: ⌘K, C, /. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        "inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-[4px] border border-border-2 bg-surface px-1 font-sans text-[11px] font-medium leading-none text-text-3",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
