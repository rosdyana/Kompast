import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";

const STORAGE_KEY = "kompast-sidebar-hidden";

interface SidebarApi {
  /** Desktop: sidebar hidden entirely (Notion's "close sidebar"). */
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  /** Mobile (<768px): drawer open over the content. */
  mobileOpen: boolean;
  setMobileOpen: (next: boolean) => void;
  /** Toggles whichever mode applies at the current width. */
  toggle: () => void;
}

const SidebarContext = createContext<SidebarApi>({
  collapsed: false,
  setCollapsed: () => {},
  mobileOpen: false,
  setMobileOpen: () => {},
  toggle: () => {},
});

export function useSidebarCollapsed() {
  return useContext(SidebarContext);
}

function isNarrow() {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
}

/**
 * State provider for the app sidebar. Wrap the whole shell (sidebar AND
 * main column) so the topbar's toggle can reach it.
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      setCollapsedState(window.localStorage.getItem(STORAGE_KEY) === "true");
    } catch {
      // storage blocked — default stays expanded
    }
  }, []);

  function setCollapsed(next: boolean) {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // not persisted; nothing depends on it
    }
  }

  return (
    <SidebarContext.Provider
      value={{
        collapsed,
        setCollapsed,
        mobileOpen,
        setMobileOpen,
        toggle: () => (isNarrow() ? setMobileOpen(!mobileOpen) : setCollapsed(!collapsed)),
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export interface SidebarShellProps {
  children: ReactNode;
  className?: string;
}

/**
 * The sidebar column: 248px on desktop (hideable), an overlay drawer on
 * mobile. The width transition is gated behind mount so first paint never
 * animates.
 */
export function SidebarShell({ children, className }: SidebarShellProps) {
  const { collapsed, mobileOpen, setMobileOpen } = useSidebarCollapsed();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <>
      {mobileOpen && (
        <div className="kp-anim-fade fixed inset-0 z-40 bg-[var(--overlay)] md:hidden" onClick={() => setMobileOpen(false)} />
      )}
      <aside
        className={clsx(
          "group/sidebar z-50 flex h-full flex-none flex-col overflow-hidden bg-surface-2",
          // mobile drawer
          "fixed inset-y-0 left-0 w-[272px] border-r border-border shadow-kp md:shadow-none",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // desktop column
          "md:static md:translate-x-0",
          collapsed ? "md:w-0 md:border-r-0" : "md:w-[248px] md:border-r",
          mounted && "transition-[width,transform] duration-200 ease-out",
          className,
        )}
      >
        <div className="flex h-full w-[272px] flex-col md:w-[248px]">{children}</div>
      </aside>
    </>
  );
}
