import { createFileRoute, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SidebarProvider, SidebarShell, useSidebarCollapsed } from "@kompast/ui/SidebarShell";
import { ToastProvider, useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { getWorkspaceShellFn } from "@/lib/server-fns/workspace";
import { listPageTreeFn, createPageFn } from "@/lib/server-fns/pages";
import { AppSidebar, type SidebarShellData } from "@/components/shell/AppSidebar";
import { Topbar } from "@/components/shell/Topbar";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { CreateIssueDialog } from "@/components/shell/CreateIssueDialog";
import { ShortcutsDialog } from "@/components/shell/ShortcutsDialog";
import { WorkbenchContext, type CreateIssueDefaults, type PageChrome } from "@/components/shell/WorkbenchContext";

export const Route = createFileRoute("/_app")({
  loader: async () => {
    const shell = await getWorkspaceShellFn();
    if (!shell) throw redirect({ to: "/login" });
    const pageTree = await listPageTreeFn();
    return { ...shell, pages: pageTree.pages, favoriteIds: pageTree.favoriteIds };
  },
  component: AppShell,
});

function isTypingTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || !!el.closest?.("[contenteditable='true']");
}

function AppShell() {
  return (
    <ToastProvider>
      <SidebarProvider>
        <Workbench />
      </SidebarProvider>
    </ToastProvider>
  );
}

function Workbench() {
  const shell = Route.useLoaderData() as SidebarShellData;
  const router = useRouter();
  const toast = useToast();
  const { t } = useTranslation(["nav", "common"]);
  const { toggle } = useSidebarCollapsed();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [createDefaults, setCreateDefaults] = useState<CreateIssueDefaults | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [chrome, setChrome] = useState<PageChrome | null>(null);

  const openCreateIssue = useCallback((defaults?: CreateIssueDefaults) => {
    setPaletteOpen(false);
    setCreateDefaults(defaults ?? null);
    setCreateOpen(true);
  }, []);

  const createPage = useCallback(
    async (opts?: { parentPageId?: string | null; projectId?: string | null }) => {
      try {
        const page = await createPageFn({ data: { parentPageId: opts?.parentPageId ?? undefined, projectId: opts?.projectId ?? undefined } });
        await router.navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
        await router.invalidate();
      } catch (err) {
        toast.show({ tone: "error", title: t("common:somethingWentWrong"), description: err instanceof Error ? err.message : undefined });
      }
    },
    [router, toast, t],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        toggle();
        return;
      }
      if (mod || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector("[role='dialog'][aria-modal='true']")) return;
      if (e.key === "/") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "c" || e.key === "C") {
        if (shell.projects.length === 0) return;
        e.preventDefault();
        openCreateIssue();
      } else if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, openCreateIssue, shell.projects.length]);

  const workbench = useMemo(
    () => ({
      openPalette: () => setPaletteOpen(true),
      openCreateIssue,
      openShortcuts: () => setShortcutsOpen(true),
      createPage,
      chrome,
      setChrome,
    }),
    [openCreateIssue, createPage, chrome],
  );

  return (
    <WorkbenchContext.Provider value={workbench}>
      <div className="flex h-screen overflow-hidden bg-bg">
        <SidebarShell>
          <AppSidebar shell={shell} />
        </SidebarShell>
        <main className="flex min-w-0 flex-1 flex-col">
          <Topbar canCreateIssue={shell.projects.length > 0} />
          <div id="kp-main-scroll" className="min-h-0 flex-1 overflow-auto">
            <Outlet />
          </div>
        </main>
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        shell={shell}
        onCreateIssue={() => openCreateIssue()}
        onCreatePage={() => createPage()}
      />
      <CreateIssueDialog open={createOpen} onClose={() => setCreateOpen(false)} defaults={createDefaults} shell={shell} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </WorkbenchContext.Provider>
  );
}
