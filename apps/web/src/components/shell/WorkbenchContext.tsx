import { createContext, useContext, useEffect, type ReactNode } from "react";

export interface CreateIssueDefaults {
  projectId?: string;
  typeId?: string;
  sprintId?: string;
  statusId?: string;
  assigneeId?: string;
  epicId?: string;
  parentId?: string;
  /** Called after a successful create (the dialog already invalidates the router). */
  onCreated?: (created: { issueId: string; keySeq: number; projectKey: string }) => void;
}

export interface Crumb {
  label: ReactNode;
  icon?: ReactNode;
  /**
   * Router target for the crumb; omit for the current (non-link) crumb.
   * Loosely typed on purpose: TanStack's per-route Link generics can't be
   * expressed for an arbitrary list of crumbs.
   */
  link?: { to: string; params?: Record<string, string>; search?: Record<string, unknown> };
}

export interface PageChrome {
  crumbs: Crumb[];
  /** Right-aligned page actions shown in the topbar (Share, ⋯, Watch…). */
  actions?: ReactNode;
}

export interface Workbench {
  openPalette: () => void;
  openCreateIssue: (defaults?: CreateIssueDefaults) => void;
  openShortcuts: () => void;
  createPage: (opts?: { parentPageId?: string | null; projectId?: string | null }) => Promise<void>;
  chrome: PageChrome | null;
  setChrome: (chrome: PageChrome | null) => void;
}

export const WorkbenchContext = createContext<Workbench>({
  openPalette: () => {},
  openCreateIssue: () => {},
  openShortcuts: () => {},
  createPage: async () => {},
  chrome: null,
  setChrome: () => {},
});

export function useWorkbench() {
  return useContext(WorkbenchContext);
}

/**
 * Registers this page's breadcrumbs + topbar actions while it's mounted.
 * `deps` works like useEffect's — pass whatever the crumbs/actions depend
 * on (ids, titles, flags), since the chrome objects themselves are new
 * every render.
 */
export function usePageChrome(chrome: PageChrome, deps: unknown[]) {
  const { setChrome } = useWorkbench();
  useEffect(() => {
    setChrome(chrome);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => () => setChrome(null), [setChrome]);
}
