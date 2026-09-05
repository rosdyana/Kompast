import { createFileRoute, Outlet, Link, redirect, useRouter } from "@tanstack/react-router";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { SidebarShell, useSidebarCollapsed } from "@kompast/ui/SidebarShell";
import { useTheme } from "@kompast/ui/theme";
import { useTranslation } from "@kompast/i18n";
import { useState } from "react";
import { getWorkspaceShellFn } from "@/lib/server-fns/workspace";
import { listPageTreeFn, createPageFn } from "@/lib/server-fns/pages";
import { GlobalSearch } from "@/components/GlobalSearch";
import { NotificationBell } from "@/components/NotificationBell";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { DocsTree } from "@/components/docs/DocsTree";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_app")({
  loader: async () => {
    const shell = await getWorkspaceShellFn();
    if (!shell) throw redirect({ to: "/login" });
    const pageTree = await listPageTreeFn();
    return { ...shell, pages: pageTree.pages };
  },
  component: AppShell,
});

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function AppShell() {
  const shell = Route.useLoaderData();
  const { t } = useTranslation("nav");

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar shell={shell} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Topbar workspaceName={shell.organization?.name ?? t("workspaceFallback")} />
        <div className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

type Shell = NonNullable<Awaited<ReturnType<typeof getWorkspaceShellFn>>> & {
  pages: Awaited<ReturnType<typeof listPageTreeFn>>["pages"];
};

function Sidebar({ shell }: { shell: Shell }) {
  const router = useRouter();
  const [creatingPage, setCreatingPage] = useState(false);

  async function handleSignOut() {
    await authClient.signOut();
    await router.navigate({ to: "/login" });
  }

  async function newPage() {
    setCreatingPage(true);
    try {
      const page = await createPageFn({ data: {} });
      await router.navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
    } finally {
      setCreatingPage(false);
    }
  }

  return (
    <SidebarShell>
      <SidebarBody shell={shell} creatingPage={creatingPage} newPage={newPage} handleSignOut={handleSignOut} />
    </SidebarShell>
  );
}

type TeamRow = Shell["teams"][number];
type ProjectRow = Shell["projects"][number];

function TeamNode({
  team,
  projects,
  isSuperAdmin,
}: {
  team: TeamRow;
  projects: ProjectRow[];
  isSuperAdmin: boolean;
}) {
  const { t } = useTranslation("nav");
  const [expanded, setExpanded] = useState(true);
  const canCreateProject = isSuperAdmin || team.myRole === "admin";

  return (
    <div>
      <div className="flex items-center gap-1.5 rounded-[7px] px-2 py-1 hover:bg-surface-3">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="grid h-4 w-4 flex-none place-items-center text-[9px] text-text-3"
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{team.name}</span>
        {canCreateProject && (
          <Link
            to="/projects/new"
            search={{ teamId: team.id === "__unassigned" ? undefined : team.id }}
            title={t("newProject")}
            className="grid h-4 w-4 flex-none place-items-center text-[11px] text-text-3 hover:text-text"
          >
            +
          </Link>
        )}
      </div>
      {expanded && (
        <div className="pl-5">
          {projects.length === 0 && <p className="px-2 py-1 text-[11.5px] text-text-3">{t("noProjectsInTeam")}</p>}
          {projects.map((project) => (
            <Link
              key={project.id}
              to="/projects/$projectKey"
              params={{ projectKey: project.key }}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-3 [&.active]:font-semibold [&.active]:bg-surface-3"
            >
              <span className="w-3.5 flex-none text-center text-[11px] text-text-3">◫</span>
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="font-mono text-[10px] text-text-3">{project.key}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarBody({
  shell,
  creatingPage,
  newPage,
  handleSignOut,
}: {
  shell: Shell;
  creatingPage: boolean;
  newPage: () => void;
  handleSignOut: () => void;
}) {
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  const { t } = useTranslation(["nav", "common"]);
  const workspaceName = shell.organization?.name ?? t("workspaceFallback");

  if (collapsed) {
    return (
      <SidebarRail
        shell={shell}
        workspaceName={workspaceName}
        handleSignOut={handleSignOut}
        onExpand={() => setCollapsed(false)}
      />
    );
  }

  return (
    <>
      <div className="flex items-center border-b border-border">
        <button
          title={workspaceName}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-3.5 text-left hover:bg-surface-3"
        >
          <div className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[7px] bg-indigo">
            <div className="h-1.5 w-1.5 rotate-45 rounded-sm bg-accent" />
          </div>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold tracking-tight">{workspaceName}</span>
            <span className="block text-[11px] text-text-3">{t("memberCount", { count: shell.memberCount })}</span>
          </span>
        </button>
        <button
          onClick={() => setCollapsed(true)}
          title={t("collapseSidebar")}
          className="mr-1.5 grid h-[30px] w-[30px] flex-none place-items-center rounded-md text-xs text-text-3 hover:bg-surface-3 hover:text-text"
        >
          «
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 pt-2.5">
        <div className="mb-4 flex flex-col gap-px">
          <Link
            to="/"
            title={t("home")}
            className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13.5px] hover:bg-surface-3 [&.active]:font-semibold [&.active]:bg-surface-3"
          >
            <span className="w-[15px] text-center text-xs text-text-3">◇</span>
            {t("home")}
          </Link>
          <button
            title={t("search")}
            className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13.5px] text-text-2 hover:bg-surface-3"
          >
            <span className="w-[15px] text-center text-xs text-text-3">⌕</span>
            {t("search")}
            <span className="ml-auto font-mono text-[10px] text-text-3">⌘K</span>
          </button>
          <Link
            to="/ask"
            title={t("askKompast")}
            className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13.5px] hover:bg-surface-3 [&.active]:font-semibold [&.active]:bg-surface-3"
          >
            <span className="w-[15px] text-center text-xs text-text-3">✨</span>
            {t("askKompast")}
          </Link>
        </div>

        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-3">{t("teams")}</span>
          {shell.isSuperAdmin && (
            <Link
              to="/teams/new"
              title={t("newTeam")}
              className="grid h-[19px] w-[19px] place-items-center rounded-md text-[10.5px] text-text-3 hover:bg-surface-3 hover:text-text"
            >
              +
            </Link>
          )}
        </div>

        <div className="mb-4 flex flex-col gap-px">
          {shell.teams.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-text-3">
              {shell.isSuperAdmin ? t("noTeamsYetSuperAdmin") : t("noTeamsYetMember")}
            </p>
          )}
          {shell.teams.map((team) => (
            <TeamNode
              key={team.id}
              team={team}
              projects={shell.projects.filter((p) => p.teamId === team.id)}
              isSuperAdmin={shell.isSuperAdmin}
            />
          ))}
          {shell.projects.some((p) => !p.teamId) && (
            <TeamNode
              team={{ id: "__unassigned", name: t("unassignedTeam"), memberCount: 0, projectCount: 0, myRole: null }}
              projects={shell.projects.filter((p) => !p.teamId)}
              isSuperAdmin={shell.isSuperAdmin}
            />
          )}
        </div>

        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-3">{t("docs")}</span>
          <div className="flex items-center gap-1">
            <Link
              to="/docs/trash"
              title={t("trash")}
              className="grid h-[19px] w-[19px] place-items-center rounded-md text-[10.5px] text-text-3 hover:bg-surface-3 hover:text-text"
            >
              🗑
            </Link>
            <Button variant="outline" className="h-[19px] px-1.5 text-[10.5px]" onClick={newPage} disabled={creatingPage}>
              +
            </Button>
          </div>
        </div>
        <DocsTree pages={shell.pages} />
      </div>

      <div className="border-t border-border p-2">
        {shell.isAdmin && (
          <Link
            to="/members"
            title={t("members")}
            className="flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13px] hover:bg-surface-3 [&.active]:bg-surface-3"
          >
            <span className="w-[15px] text-center text-xs text-text-3">◔</span>
            {t("members")}
          </Link>
        )}
        {shell.isAdmin && (
          <Link
            to="/settings"
            title={t("settings")}
            className="flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13px] hover:bg-surface-3 [&.active]:bg-surface-3"
          >
            <span className="w-[15px] text-center text-xs text-text-3">⚙</span>
            {t("settings")}
          </Link>
        )}
        <Link
          to="/tokens"
          title={t("apiToken")}
          className="flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13px] hover:bg-surface-3 [&.active]:bg-surface-3"
        >
          <span className="w-[15px] text-center text-xs text-text-3">🔑</span>
          {t("apiToken")}
        </Link>
        <a
          href="/api/docs"
          target="_blank"
          rel="noreferrer"
          title={t("apiDocs")}
          className="flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13px] hover:bg-surface-3"
        >
          <span className="w-[15px] text-center text-xs text-text-3">📖</span>
          {t("apiDocs")}
        </a>
        <div className="flex items-center gap-2.5 px-2 pb-0.5 pt-1.5">
          <Avatar initials={initialsOf(shell.user.name)} tone="violet" size={24} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold">{shell.user.name}</span>
          </span>
          <button
            onClick={handleSignOut}
            title={t("logOut")}
            className="rounded-md px-1 py-0.5 text-[11px] text-text-3 hover:bg-surface-3 hover:text-text"
          >
            ⏏
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Icon-only "rail" mode — matches the approved design mockup's railMode
 * (62px, the default state), a structurally distinct layout from the
 * expanded tree, not just the tree with labels hidden. Clicking the
 * workspace icon expands; there is no floating/absolutely-positioned
 * button here (that was the source of the original collapse bug).
 */
function SidebarRail({
  shell,
  workspaceName,
  handleSignOut,
  onExpand,
}: {
  shell: Shell;
  workspaceName: string;
  handleSignOut: () => void;
  onExpand: () => void;
}) {
  const { t } = useTranslation(["nav", "common"]);

  return (
    <div className="flex h-full w-full flex-col items-center gap-1 pb-2 pt-2.5">
      <button
        onClick={onExpand}
        title={t("expandSidebar", { name: workspaceName })}
        className="grid h-[38px] w-[38px] flex-none place-items-center rounded-[11px] bg-indigo hover:opacity-90"
      >
        <span className="h-[9px] w-[9px] rotate-45 rounded-sm bg-accent" />
      </button>

      <div className="my-2 h-px w-6 flex-none bg-border" />

      <div className="flex flex-none flex-col gap-1">
        <Link
          to="/"
          title={t("home")}
          className="grid h-9 w-10 place-items-center rounded-[10px] text-[13px] text-text-3 hover:bg-surface-3 hover:text-text [&.active]:bg-surface-3 [&.active]:text-text"
        >
          ◇
        </Link>
        <button
          title={t("search")}
          className="grid h-9 w-10 place-items-center rounded-[10px] text-[13px] text-text-2 hover:bg-surface-3 hover:text-text"
        >
          ⌕
        </button>
        <Link
          to="/ask"
          title={t("askKompast")}
          className="grid h-9 w-10 place-items-center rounded-[10px] text-[13px] text-text-3 hover:bg-surface-3 hover:text-text [&.active]:bg-surface-3 [&.active]:text-text"
        >
          ✨
        </Link>
      </div>

      <div className="my-2 h-px w-6 flex-none bg-border" />

      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
        {shell.projects.map((project) => (
          <Link
            key={project.id}
            to="/projects/$projectKey"
            params={{ projectKey: project.key }}
            title={project.name}
            className="grid h-9 w-10 flex-none place-items-center rounded-[10px] text-[10.5px] font-semibold text-text-2 hover:bg-surface-3 hover:text-text [&.active]:bg-surface-3 [&.active]:text-text"
          >
            {project.key.slice(0, 2)}
          </Link>
        ))}
      </div>

      {shell.isAdmin && (
        <Link
          to="/settings"
          title={t("settings")}
          className="grid h-9 w-10 flex-none place-items-center rounded-[10px] text-[13px] text-text-3 hover:bg-surface-3 hover:text-text [&.active]:bg-surface-3 [&.active]:text-text"
        >
          ⚙
        </Link>
      )}
      <button
        onClick={handleSignOut}
        title={`${shell.user.name} · ${t("logOut")}`}
        className="mt-1 flex-none rounded-full hover:opacity-85"
      >
        <Avatar initials={initialsOf(shell.user.name)} tone="violet" size={28} />
      </button>
    </div>
  );
}

function Topbar({ workspaceName }: { workspaceName: string }) {
  const { theme, toggleTheme } = useTheme();
  const { t } = useTranslation("nav");
  return (
    <header className="flex h-[47px] flex-none items-center gap-3.5 border-b border-border bg-surface-2 px-[18px]">
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-2">
        <span className="truncate font-semibold text-text">{workspaceName}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <GlobalSearch />
        <NotificationBell />
        <LocaleSwitcher />
        <button
          onClick={toggleTheme}
          title={theme === "dark" ? t("themeToLight") : t("themeToDark")}
          className="grid h-[29px] w-[29px] place-items-center rounded-[7px] border border-border bg-surface text-xs hover:bg-surface-3"
        >
          {theme === "dark" ? "☾" : "☀"}
        </button>
      </div>
    </header>
  );
}
