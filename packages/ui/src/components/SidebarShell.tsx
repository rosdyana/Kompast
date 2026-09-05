import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";

const STORAGE_KEY = "kompast-sidebar-collapsed";

interface SidebarCollapsedApi {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
}

const SidebarCollapsedContext = createContext<SidebarCollapsedApi>({ collapsed: true, setCollapsed: () => {} });

export function useSidebarCollapsed() {
  return useContext(SidebarCollapsedContext);
}

export interface SidebarShellProps {
  children: ReactNode;
  className?: string;
}

/**
 * Pure width/collapse-state shell — matches the approved design mockup's
 * railMode (62px, collapsed, the DEFAULT) vs treeMode (252px, expanded)
 * split. The actual expand/collapse triggers (clicking the workspace icon
 * to expand, a "«" button to collapse) live inside the consumer's content
 * via useSidebarCollapsed()'s setCollapsed — this component only owns the
 * width/persistence, not any button, so there's nothing here that can end
 * up clipped by overflow-hidden (a real bug this file used to have).
 */
export function SidebarShell({ children, className }: SidebarShellProps) {
  const [collapsed, setCollapsedState] = useState(() => {
    // No stored preference yet -> collapsed ("rail" mode) by default.
    if (typeof window === "undefined") return true;
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  });
  // Gate the width transition behind mount so the initial render never
  // animates — only a user-triggered toggle after mount should visibly slide.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  function setCollapsed(next: boolean) {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // localStorage unavailable (private mode, blocked) — collapse state
      // just won't persist across reloads, nothing else depends on it.
    }
  }

  return (
    <SidebarCollapsedContext.Provider value={{ collapsed, setCollapsed }}>
      <aside
        className={clsx(
          "flex flex-none flex-col overflow-hidden border-r border-border bg-surface-2",
          collapsed ? "w-[62px]" : "w-[252px]",
          mounted && "transition-[width] duration-200 ease-out",
          className,
        )}
      >
        {children}
      </aside>
    </SidebarCollapsedContext.Provider>
  );
}
