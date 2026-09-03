import { createFileRoute, Outlet, Link, redirect, useRouter } from "@tanstack/react-router";
import { Avatar } from "@kompast/ui/Avatar";
import { SearchField } from "@kompast/ui/Input";
import { getWorkspaceShellFn } from "@/lib/server-fns/workspace";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_app")({
  loader: async () => {
    const shell = await getWorkspaceShellFn();
    if (!shell) throw redirect({ to: "/login" });
    return shell;
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

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar shell={shell} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Topbar workspaceName={shell.organization?.name ?? "Workspace"} />
        <div className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

type Shell = Awaited<ReturnType<typeof getWorkspaceShellFn>>;

function Sidebar({ shell }: { shell: NonNullable<Shell> }) {
  const router = useRouter();

  async function handleSignOut() {
    await authClient.signOut();
    await router.navigate({ to: "/login" });
  }

  return (
    <aside className="flex w-[252px] flex-none flex-col border-r border-border bg-surface-2">
      <button className="flex items-center gap-2.5 border-b border-border px-3 py-3.5 text-left hover:bg-surface-3">
        <div className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[7px] bg-indigo">
          <div className="h-1.5 w-1.5 rotate-45 rounded-sm bg-accent" />
        </div>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold tracking-tight">
            {shell.organization?.name ?? "Workspace"}
          </span>
          <span className="block text-[11px] text-text-3">Workspace · {shell.memberCount} anggota</span>
        </span>
        <span className="text-[10px] text-text-3">▾</span>
      </button>

      <div className="flex-1 overflow-y-auto px-2 pb-2 pt-2.5">
        <div className="mb-4 flex flex-col gap-px">
          <Link
            to="/"
            className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13.5px] hover:bg-surface-3 [&.active]:font-semibold [&.active]:bg-surface-3"
          >
            <span className="w-[15px] text-center text-xs text-text-3">◇</span>Home
          </Link>
          <button className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13.5px] text-text-2 hover:bg-surface-3">
            <span className="w-[15px] text-center text-xs text-text-3">⌕</span>Cari
            <span className="ml-auto font-mono text-[10px] text-text-3">⌘K</span>
          </button>
        </div>

        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-3">Proyek</span>
        </div>

        <div className="flex flex-col gap-px">
          {shell.projects.length === 0 && (
            <p className="px-2 py-1.5 text-[12px] text-text-3">Belum ada proyek</p>
          )}
          {shell.projects.map((project) => (
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
      </div>

      <div className="border-t border-border p-2">
        {shell.isAdmin && (
          <Link
            to="/settings"
            className="flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13px] hover:bg-surface-3 [&.active]:bg-surface-3"
          >
            <span className="w-[15px] text-center text-xs text-text-3">⚙</span>Pengaturan
          </Link>
        )}
        <div className="flex items-center gap-2.5 px-2 pb-0.5 pt-1.5">
          <Avatar initials={initialsOf(shell.user.name)} tone="violet" size={24} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold">{shell.user.name}</span>
          </span>
          <button
            onClick={handleSignOut}
            title="Keluar"
            className="rounded-md px-1 py-0.5 text-[11px] text-text-3 hover:bg-surface-3 hover:text-text"
          >
            ⏏
          </button>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ workspaceName }: { workspaceName: string }) {
  return (
    <header className="flex h-[47px] flex-none items-center gap-3.5 border-b border-border bg-surface-2 px-[18px]">
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-2">
        <span className="truncate font-semibold text-text">{workspaceName}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <SearchField placeholder="Cari doc, tiket, orang…" className="w-[210px]" />
        <button className="grid h-[29px] w-[29px] place-items-center rounded-[7px] border border-border bg-surface text-xs hover:bg-surface-3">
          ☀
        </button>
        <button className="rounded-[7px] bg-text px-3 py-1.5 text-[12.5px] font-semibold text-bg hover:opacity-[.88]">
          Bagikan
        </button>
      </div>
    </header>
  );
}
