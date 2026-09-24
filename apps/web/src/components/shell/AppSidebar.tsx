import { useRef, useState, type ReactNode } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  FileText,
  Home,
  Inbox,
  KanbanSquare,
  KeyRound,
  Languages,
  LogOut,
  Map as MapIcon,
  Moon,
  Plus,
  Search,
  Settings,
  Sparkles,
  SquarePen,
  Star,
  Sun,
  Table2,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { Avatar } from "@kompast/ui/Avatar";
import { Kbd } from "@kompast/ui/Kbd";
import { Popover } from "@kompast/ui/Popover";
import { MenuItem, MenuList, MenuSeparator, MenuLabel } from "@kompast/ui/Menu";
import { useSidebarCollapsed } from "@kompast/ui/SidebarShell";
import { useTheme } from "@kompast/ui/theme";
import { useTranslation, SUPPORTED_LOCALES, LOCALE_LABELS, type SupportedLocale } from "@kompast/i18n";
import { authClient } from "@/lib/auth-client";
import { setLocaleFn } from "@/lib/server-fns/locale";
import { cn } from "@/lib/cn";
import { DocsTree, PageIcon, type DocsTreePage } from "@/components/docs/DocsTree";
import { CompassMark, ProjectIcon } from "./ProjectIcon";
import { useWorkbench } from "./WorkbenchContext";

export interface SidebarShellData {
  user: { id: string; name: string };
  organization: { name: string } | null;
  memberCount: number;
  projects: { id: string; key: string; name: string; teamId: string | null }[];
  teams: { id: string; name: string; myRole: string | null }[];
  isAdmin: boolean;
  isSuperAdmin: boolean;
  pages: DocsTreePage[];
  favoriteIds: string[];
}

const row =
  "group/row flex h-[30px] w-full items-center gap-2 rounded-[6px] px-2 text-left text-[14px] text-text-2 outline-none transition-colors hover:bg-surface-3 hover:text-text";
const rowActive = "[&.active]:bg-surface-4 [&.active]:font-medium [&.active]:text-text";

function NavLink({ to, icon, children, hint }: { to: "/" | "/ask" | "/docs/trash" | "/settings" | "/tokens"; icon: ReactNode; children: ReactNode; hint?: ReactNode }) {
  const { setMobileOpen } = useSidebarCollapsed();
  return (
    <Link to={to} activeOptions={{ exact: to === "/" }} onClick={() => setMobileOpen(false)} className={cn(row, rowActive)}>
      <span className="grid w-[18px] flex-none place-items-center text-text-3">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint}
    </Link>
  );
}

function SectionHeader({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="group/section flex h-7 items-center gap-1 pl-2 pr-1 pt-2">
      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-text-3">{label}</span>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/section:opacity-100">{children}</div>
    </div>
  );
}

function HoverAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-[22px] w-[22px] flex-none place-items-center rounded-[4px] text-text-3 hover:bg-surface-4 hover:text-text"
    >
      {children}
    </button>
  );
}

type ProjectView = "backlog" | "board" | "table" | "roadmap" | "docs" | "automation";
const PROJECT_VIEWS: { key: ProjectView; icon: typeof Inbox }[] = [
  { key: "backlog", icon: Inbox },
  { key: "board", icon: KanbanSquare },
  { key: "table", icon: Table2 },
  { key: "roadmap", icon: MapIcon },
  { key: "docs", icon: FileText },
  { key: "automation", icon: Zap },
];

function ProjectNode({ project, teamParam }: { project: SidebarShellData["projects"][number]; teamParam: string }) {
  const { t } = useTranslation("nav");
  const { setMobileOpen } = useSidebarCollapsed();
  const location = useRouterState({ select: (s) => s.location });
  const base = `/projects/${teamParam}/${project.key}`;
  const isHere = location.pathname === base || location.pathname.startsWith(`/issues/${teamParam}/${project.key}/`);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const open = openOverride ?? isHere;
  const currentTab = (location.search as { tab?: string }).tab ?? "backlog";

  return (
    <div>
      <div className={cn(row, "pl-1 pr-1", isHere && !open && "bg-surface-4 font-medium text-text")}>
        <button
          type="button"
          onClick={() => setOpenOverride(!open)}
          aria-label={project.name}
          aria-expanded={open}
          className="relative grid h-[22px] w-[22px] flex-none place-items-center rounded-[4px] hover:bg-surface-4"
        >
          <span className="transition-opacity group-hover/row:opacity-0">
            <ProjectIcon projectKey={project.key} size={18} />
          </span>
          <ChevronRight size={14} strokeWidth={2} className={cn("absolute opacity-0 transition group-hover/row:opacity-100", open && "rotate-90")} />
        </button>
        <Link
          to="/projects/$teamId/$projectKey"
          params={{ teamId: teamParam, projectKey: project.key }}
          search={{ tab: "backlog" }}
          onClick={() => {
            setOpenOverride(true);
            setMobileOpen(false);
          }}
          className="flex h-full min-w-0 flex-1 items-center truncate pl-1"
        >
          <span className="truncate">{project.name}</span>
        </Link>
      </div>
      {open && (
        <div className="flex flex-col gap-px pb-1">
          {PROJECT_VIEWS.map(({ key, icon: Icon }) => {
            const active = location.pathname === base && currentTab === key;
            return (
              <Link
                key={key}
                to="/projects/$teamId/$projectKey"
                params={{ teamId: teamParam, projectKey: project.key }}
                search={{ tab: key }}
                onClick={() => setMobileOpen(false)}
                className={cn(row, "h-[28px] pl-[34px] text-[13.5px]", active && "bg-surface-4 font-medium text-text")}
              >
                <Icon size={15} strokeWidth={1.75} className="flex-none text-text-3" />
                <span className="truncate">{t(`views.${key}`)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeamGroup({
  team,
  projects,
  canCreateProject,
  canManageTeam,
}: {
  team: { id: string; name: string };
  projects: SidebarShellData["projects"];
  canCreateProject: boolean;
  canManageTeam: boolean;
}) {
  const { t } = useTranslation("nav");
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const isUnassigned = team.id === "__unassigned";

  return (
    <div>
      <div className="group/team flex h-7 items-center gap-1 rounded-[6px] pl-1 pr-1 hover:bg-surface-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex h-full min-w-0 flex-1 items-center gap-1 text-left text-[12.5px] font-medium text-text-3 hover:text-text-2"
        >
          <ChevronDown size={13} strokeWidth={2} className={cn("flex-none transition-transform", !open && "-rotate-90")} />
          <span className="truncate">{team.name}</span>
        </button>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/team:opacity-100">
          {canManageTeam && (
            <HoverAction label={t("manageTeam")} onClick={() => router.navigate({ to: "/teams/$teamId", params: { teamId: team.id } })}>
              <Settings size={13} strokeWidth={1.75} />
            </HoverAction>
          )}
          {canCreateProject && (
            <HoverAction
              label={t("newProject")}
              onClick={() => router.navigate({ to: "/projects/new", search: { teamId: isUnassigned ? undefined : team.id } })}
            >
              <Plus size={14} strokeWidth={2} />
            </HoverAction>
          )}
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-px">
          {projects.length === 0 && <p className="py-1 pl-7 text-[13px] text-text-3">{t("noProjectsInTeam")}</p>}
          {projects.map((p) => (
            <ProjectNode key={p.id} project={p} teamParam={isUnassigned ? "none" : team.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceMenu({ shell }: { shell: SidebarShellData }) {
  const { t, i18n } = useTranslation(["nav", "common"]);
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const langRef = useRef<HTMLButtonElement>(null);
  const { setCollapsed } = useSidebarCollapsed();
  const workspaceName = shell.organization?.name ?? t("workspaceFallback");

  async function signOut() {
    await authClient.signOut();
    await router.navigate({ to: "/login" });
  }

  async function selectLocale(locale: SupportedLocale) {
    setLangOpen(false);
    setOpen(false);
    await setLocaleFn({ data: { locale } });
    await router.invalidate();
  }

  return (
    <div className="flex h-12 flex-none items-center gap-1 px-2">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("workspaceMenu")}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[6px] px-1.5 text-left hover:bg-surface-3"
      >
        <CompassMark size={22} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-text">{workspaceName}</span>
        <ChevronDown size={14} strokeWidth={2} className="flex-none text-text-3" />
      </button>
      <button
        type="button"
        onClick={() => setCollapsed(true)}
        aria-label={t("collapseSidebar")}
        title={`${t("collapseSidebar")} (⌘\\)`}
        className="hidden h-7 w-7 flex-none place-items-center rounded-[6px] text-text-3 opacity-0 transition-opacity hover:bg-surface-3 hover:text-text focus-visible:opacity-100 group-hover/sidebar:opacity-100 md:grid"
      >
        <ChevronsLeft size={17} strokeWidth={1.75} />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} width={280} role="menu" ignoreRefs={[langRef]}>
        <div className="flex items-center gap-2.5 border-b border-border px-3 py-3">
          <CompassMark size={32} />
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold">{workspaceName}</p>
            <p className="text-[12.5px] text-text-3">{t("memberCount", { count: shell.memberCount })}</p>
          </div>
        </div>
        <MenuList>
          {shell.isAdmin && (
            <MenuItem icon={<Settings size={15} />} onClick={() => { setOpen(false); router.navigate({ to: "/settings" }); }}>
              {t("settings")}
            </MenuItem>
          )}
          {shell.isAdmin && (
            <MenuItem icon={<Users size={15} />} onClick={() => { setOpen(false); router.navigate({ to: "/settings", search: { tab: "members" } }); }}>
              {t("members")}
            </MenuItem>
          )}
          <MenuItem icon={<KeyRound size={15} />} onClick={() => { setOpen(false); router.navigate({ to: "/tokens" }); }}>
            {t("apiToken")}
          </MenuItem>
          <MenuItem icon={<BookOpen size={15} />} onClick={() => { setOpen(false); window.open("/api/docs", "_blank", "noreferrer"); }}>
            {t("apiDocs")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={theme === "dark" ? <Sun size={15} /> : <Moon size={15} />} onClick={toggleTheme} hint={theme === "dark" ? t("themeDark") : t("themeLight")}>
            {theme === "dark" ? t("themeToLight") : t("themeToDark")}
          </MenuItem>
          <MenuItem ref={langRef} icon={<Languages size={15} />} onClick={() => setLangOpen(!langOpen)} hint={LOCALE_LABELS[i18n.language as SupportedLocale]}>
            {t("language")}
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>{shell.user.name}</MenuLabel>
          <MenuItem icon={<LogOut size={15} />} onClick={signOut}>
            {t("logOut")}
          </MenuItem>
        </MenuList>
      </Popover>
      <Popover open={open && langOpen} onClose={() => setLangOpen(false)} anchorRef={langRef} placement="right-start" width={200} role="menu">
        <MenuList>
          {SUPPORTED_LOCALES.map((locale) => (
            <MenuItem key={locale} onClick={() => selectLocale(locale)} selected={locale === i18n.language}>
              {LOCALE_LABELS[locale]}
            </MenuItem>
          ))}
        </MenuList>
      </Popover>
    </div>
  );
}

export function AppSidebar({ shell }: { shell: SidebarShellData }) {
  const { t } = useTranslation("nav");
  const { openPalette, openCreateIssue, createPage } = useWorkbench();
  const { setMobileOpen } = useSidebarCollapsed();
  const favorites = shell.pages.filter((p) => shell.favoriteIds.includes(p.id));
  const workspacePages = shell.pages;

  const teamGroups = [
    ...shell.teams.map((team) => ({
      team,
      projects: shell.projects.filter((p) => p.teamId === team.id),
      canCreateProject: shell.isSuperAdmin || team.myRole === "admin",
      canManageTeam: shell.isSuperAdmin || team.myRole === "admin",
    })),
    ...(shell.projects.some((p) => !p.teamId)
      ? [
          {
            team: { id: "__unassigned", name: t("unassignedTeam") },
            projects: shell.projects.filter((p) => !p.teamId),
            canCreateProject: shell.isSuperAdmin,
            canManageTeam: false,
          },
        ]
      : []),
  ];

  return (
    <>
      <WorkspaceMenu shell={shell} />

      <div className="flex flex-col gap-px px-2 pb-2">
        <button type="button" onClick={() => { setMobileOpen(false); openPalette(); }} className={row}>
          <Search size={16} strokeWidth={1.75} className="w-[18px] flex-none text-text-3" />
          <span className="min-w-0 flex-1 truncate">{t("search")}</span>
          <Kbd className="opacity-0 group-hover/row:opacity-100">⌘K</Kbd>
        </button>
        <NavLink to="/" icon={<Home size={16} strokeWidth={1.75} />}>
          {t("home")}
        </NavLink>
        <NavLink to="/ask" icon={<Sparkles size={16} strokeWidth={1.75} />}>
          {t("askKompast")}
        </NavLink>
        <button
          type="button"
          onClick={() => { setMobileOpen(false); openCreateIssue(); }}
          disabled={shell.projects.length === 0}
          className={cn(row, "disabled:opacity-50")}
        >
          <SquarePen size={16} strokeWidth={1.75} className="w-[18px] flex-none text-text-3" />
          <span className="min-w-0 flex-1 truncate">{t("createIssue")}</span>
          <Kbd className="opacity-0 group-hover/row:opacity-100">C</Kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {favorites.length > 0 && (
          <div className="mb-2">
            <SectionHeader label={t("favorites")} />
            <div className="flex flex-col gap-px">
              {favorites.map((p) => (
                <Link
                  key={p.id}
                  to="/docs/$pageId"
                  params={{ pageId: p.id }}
                  onClick={() => setMobileOpen(false)}
                  className={cn(row, rowActive, "pl-[7px]")}
                >
                  <PageIcon icon={p.icon} size={16} />
                  <span className="min-w-0 flex-1 truncate">{p.title || t("palette.untitled")}</span>
                  <Star size={12} strokeWidth={2} className="flex-none fill-current text-amber opacity-70" />
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="mb-2">
          <SectionHeader label={t("projects")}>
            {shell.isSuperAdmin && (
              <Link
                to="/teams/new"
                title={t("newTeam")}
                aria-label={t("newTeam")}
                className="grid h-[22px] w-[22px] place-items-center rounded-[4px] text-text-3 hover:bg-surface-4 hover:text-text"
              >
                <Users size={13} strokeWidth={1.75} />
              </Link>
            )}
          </SectionHeader>
          {teamGroups.length === 0 ? (
            <p className="px-2 py-1 text-[13px] text-text-3">{shell.isSuperAdmin ? t("noTeamsYetSuperAdmin") : t("noTeamsYetMember")}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {teamGroups.map((g) => (
                <TeamGroup key={g.team.id} {...g} />
              ))}
            </div>
          )}
        </div>

        <div>
          <SectionHeader label={t("docs")}>
            <HoverAction label={t("newPage")} onClick={() => createPage()}>
              <Plus size={14} strokeWidth={2} />
            </HoverAction>
          </SectionHeader>
          <DocsTree pages={workspacePages} onAddChild={(parentPageId) => createPage({ parentPageId })} />
          <button type="button" onClick={() => createPage()} className={cn(row, "mt-px text-text-3")}>
            <Plus size={16} strokeWidth={1.75} className="w-[18px] flex-none" />
            <span className="truncate">{t("newPage")}</span>
          </button>
        </div>
      </div>

      <div className="flex flex-none flex-col gap-px border-t border-border px-2 py-2">
        <NavLink to="/docs/trash" icon={<Trash2 size={16} strokeWidth={1.75} />}>
          {t("trash")}
        </NavLink>
        {shell.isAdmin && (
          <NavLink to="/settings" icon={<Settings size={16} strokeWidth={1.75} />}>
            {t("settings")}
          </NavLink>
        )}
        <div className="flex h-9 items-center gap-2 px-2">
          <Avatar name={shell.user.name} size={22} />
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-text">{shell.user.name}</span>
        </div>
      </div>
    </>
  );
}
