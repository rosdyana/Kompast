import { createFileRoute, Outlet, Link } from "@tanstack/react-router";
import { Avatar } from "@kompast/ui/Avatar";
import { SearchField } from "@kompast/ui/Input";
import { currentUser, teams } from "@/lib/mock-data";

export const Route = createFileRoute("/_app")({
  component: AppShell,
});

function AppShell() {
  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <div className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="flex w-[252px] flex-none flex-col border-r border-border bg-surface-2">
      <button className="flex items-center gap-2.5 border-b border-border px-3 py-3.5 text-left hover:bg-surface-3">
        <div className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[7px] bg-indigo">
          <div className="h-1.5 w-1.5 rotate-45 rounded-sm bg-accent" />
        </div>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold tracking-tight">
            Cloud Platform
          </span>
          <span className="block text-[11px] text-text-3">Workspace · 148 anggota</span>
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
          <button className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13.5px] hover:bg-surface-3">
            <span className="w-[15px] text-center text-xs text-text-3">◔</span>Inbox
            <span className="ml-auto rounded-full bg-accent px-1.5 py-px font-mono text-[10px] font-semibold text-white">
              4
            </span>
          </button>
          <button className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13.5px] text-text-2 hover:bg-surface-3">
            <span className="w-[15px] text-center text-xs text-text-3">⌕</span>Cari
            <span className="ml-auto font-mono text-[10px] text-text-3">⌘K</span>
          </button>
        </div>

        <div className="flex items-center justify-between px-2 pb-1.5">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-3">
            Tim
          </span>
          <span className="text-[13px] text-text-3">+</span>
        </div>

        {teams.map((team) => (
          <div key={team.id} className="mb-3">
            <div className="flex items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12.5px] font-semibold text-text-2">
              <span
                className="h-3.5 w-3.5 flex-none rounded"
                style={{ background: team.color }}
              />
              {team.name}
              <span className="ml-auto text-[10px] text-text-3">▾</span>
            </div>
            <div className="ml-2.5 mt-0.5 flex flex-col gap-px border-l border-border pl-2.5">
              {team.items.map((node) => (
                <Link
                  key={node.id}
                  to="/projects/$projectKey"
                  params={{ projectKey: node.id }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-3 [&.active]:font-semibold [&.active]:bg-surface-3"
                >
                  <span className="w-3.5 flex-none text-center text-[11px] text-text-3">
                    {node.glyph}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  <span className="font-mono text-[10px] text-text-3">{node.meta}</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border p-2">
        <button className="flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-[13px] hover:bg-surface-3">
          <span className="w-[15px] text-center text-xs text-text-3">⚙</span>Pengaturan
        </button>
        <div className="flex items-center gap-2.5 px-2 pb-0.5 pt-1.5">
          <Avatar initials={currentUser.initials} tone="violet" size={24} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold">
              {currentUser.name}
            </span>
            <span className="block text-[10.5px] text-text-3">{currentUser.role}</span>
          </span>
          <Link
            to="/login"
            title="Lihat layar login"
            className="rounded-md px-1 py-0.5 text-[11px] text-text-3 hover:bg-surface-3 hover:text-text"
          >
            ⏏
          </Link>
        </div>
      </div>
    </aside>
  );
}

function Topbar() {
  return (
    <header className="flex h-[47px] flex-none items-center gap-3.5 border-b border-border bg-surface-2 px-[18px]">
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-2">
        <span>Platform</span>
        <span className="text-text-3">/</span>
        <span className="truncate font-semibold text-text">Kompast Core</span>
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
