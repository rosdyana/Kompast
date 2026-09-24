import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, HelpCircle, Menu, PanelLeft, Plus } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { useSidebarCollapsed } from "@kompast/ui/SidebarShell";
import { useTranslation } from "@kompast/i18n";
import { NotificationBell } from "@/components/NotificationBell";
import { cn } from "@/lib/cn";
import { useWorkbench } from "./WorkbenchContext";

export function Topbar({ canCreateIssue }: { canCreateIssue: boolean }) {
  const { t } = useTranslation("nav");
  const { chrome, openCreateIssue, openShortcuts } = useWorkbench();
  const { collapsed, toggle } = useSidebarCollapsed();
  const crumbs = chrome?.crumbs ?? [];

  return (
    <header className="flex h-11 flex-none items-center gap-2 border-b border-border bg-bg px-2 sm:px-3">
      <IconButton aria-label={t("openSidebar")} onClick={toggle} className="md:hidden">
        <Menu size={17} strokeWidth={1.75} />
      </IconButton>
      {collapsed && (
        <IconButton aria-label={t("openSidebar")} title={`${t("openSidebar")} (⌘\\)`} onClick={toggle} className="hidden md:grid">
          <PanelLeft size={17} strokeWidth={1.75} />
        </IconButton>
      )}

      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-0.5 text-[14px]">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          const content = (
            <>
              {crumb.icon && <span className="grid flex-none place-items-center">{crumb.icon}</span>}
              <span className="truncate">{crumb.label}</span>
            </>
          );
          return (
            <Fragment key={i}>
              {i > 0 && <ChevronRight size={14} strokeWidth={1.75} className="flex-none text-text-3" />}
              {crumb.link && !last ? (
                <Link
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see Crumb.link
                  {...(crumb.link as any)}
                  className={cn(
                    "flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 rounded-[5px] px-1.5 text-text-2 hover:bg-surface-3 hover:text-text",
                  )}
                >
                  {content}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={cn("flex h-7 min-w-0 items-center gap-1.5 px-1.5", last ? "font-medium text-text" : "text-text-2")}
                >
                  {content}
                </span>
              )}
            </Fragment>
          );
        })}
      </nav>

      <div className="flex flex-none items-center gap-1">
        {chrome?.actions}
        {chrome?.actions && <span className="mx-1 hidden h-5 w-px bg-border sm:block" />}
        <IconButton aria-label={t("keyboardShortcuts")} title={`${t("keyboardShortcuts")} (?)`} onClick={openShortcuts} className="hidden sm:grid">
          <HelpCircle size={17} strokeWidth={1.75} />
        </IconButton>
        <NotificationBell />
        {canCreateIssue && (
          <Button variant="primary" size="sm" onClick={() => openCreateIssue()} title={`${t("createIssue")} (C)`} className="ml-1">
            <Plus size={15} strokeWidth={2.25} />
            <span className="hidden sm:inline">{t("create")}</span>
          </Button>
        )}
      </div>
    </header>
  );
}
