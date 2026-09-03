import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Badge } from "@kompast/ui/Badge";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { Tabs } from "@kompast/ui/Tabs";
import { boardColumns } from "@/lib/mock-data";

export const Route = createFileRoute("/_app/projects/$projectKey")({
  component: ProjectPage,
});

const VIEW_TABS = [
  { key: "board", label: "Board", icon: "◫" },
  { key: "table", label: "Tabel", icon: "▤" },
  { key: "timeline", label: "Timeline", icon: "▬" },
  { key: "docs", label: "Docs", icon: "▤" },
  { key: "automation", label: "Otomasi", icon: "⚡" },
];

function ProjectPage() {
  const { projectKey } = Route.useParams();
  const [view, setView] = useState("board");

  return (
    <div>
      <div className="border-b border-border bg-surface-2 px-6 pt-5">
        <div className="flex items-start gap-3.5">
          <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-indigo text-[13px] font-bold text-white">
            K
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="mb-1 text-xl font-semibold tracking-tight">{projectKey}</h1>
            <p className="text-xs text-text-2">
              Satu database · 32 tiket · 14 doc terkait · Sprint 24 berakhir 8 Sep
            </p>
          </div>
          <div className="flex gap-1.5">
            <Button variant="outline" className="text-[12.5px]">⚡ 3 otomasi aktif</Button>
            <Button variant="primary" className="text-[12.5px]">+ Tiket baru</Button>
          </div>
        </div>
        <Tabs items={VIEW_TABS} active={view} onChange={setView} className="mt-4" />
      </div>

      {view === "board" ? (
        <BoardView />
      ) : (
        <div className="p-10 text-center text-sm text-text-3">
          Mode <strong className="text-text-2">{VIEW_TABS.find((t) => t.key === view)?.label}</strong>{" "}
          belum dibangun — lihat fase di plan (Table &amp; Timeline: P1/P3, Docs: P2, Otomasi: P6).
        </div>
      )}
    </div>
  );
}

function BoardView() {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2.5">
        <div className="flex w-[190px] items-center gap-1.5 rounded-[7px] border border-border bg-surface px-2.5 py-1.5">
          <span className="text-[11px] text-text-3">⌕</span>
          <input
            placeholder="Cari di board"
            className="min-w-0 flex-1 border-none bg-transparent text-[12.5px] outline-none placeholder:text-text-3"
          />
        </div>
        <button className="rounded-full border border-dashed border-border-2 px-2.5 py-1.5 text-xs text-text-2 hover:bg-surface-3">
          + Filter
        </button>
        <div className="ml-auto flex items-center gap-2 text-[11.5px] text-text-3">
          Grup: <strong className="font-semibold text-text-2">Status</strong>
        </div>
      </div>

      <div
        className="flex min-h-[calc(100vh-200px)] items-start gap-3.5 overflow-x-auto px-6 pb-7 pt-4"
        style={{
          backgroundImage: "radial-gradient(var(--grid) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
        }}
      >
        {boardColumns.map((col) => (
          <div key={col.id} className="flex w-[274px] flex-none flex-col gap-2.5">
            <div className="flex items-center gap-2 px-0.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: col.color }} />
              <span className="text-[12.5px] font-semibold tracking-tight">{col.name}</span>
              <span className="font-mono text-[10.5px] text-text-3">{col.cards.length}</span>
              {col.isBacklog && <Badge>tetap</Badge>}
              <span className="ml-auto flex gap-1">
                <button className="rounded px-1 py-0.5 text-[11px] text-text-3 hover:bg-surface-3 hover:text-text">
                  ✎
                </button>
                {col.canDelete && (
                  <button className="rounded px-1 py-0.5 text-[11px] text-text-3 hover:bg-accent-soft hover:text-accent">
                    ✕
                  </button>
                )}
              </span>
            </div>

            {col.overWip && (
              <div className="flex items-center gap-1.5 rounded-lg border border-amber bg-amber-soft px-2.5 py-1.5 text-[11px] font-medium text-amber">
                <span>◮</span>
                {col.wipText}
              </div>
            )}

            <div className="flex flex-col gap-2">
              {col.cards.map((c) => (
                <button
                  key={c.key}
                  className="block w-full animate-[kp-rise_.18s_ease_both] rounded-[10px] border border-border bg-surface p-2.5 text-left hover:border-border-2 hover:shadow-kp"
                >
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span className="font-mono text-[10px] font-medium text-text-3">{c.key}</span>
                    <span
                      className="rounded px-1 py-px text-[9.5px] font-bold uppercase tracking-[0.03em]"
                      style={{ background: c.typeBg, color: c.typeFg }}
                    >
                      {c.type}
                    </span>
                    {c.blocked && (
                      <span className="ml-auto rounded bg-accent px-1.5 py-px text-[9.5px] font-bold text-white">
                        BLOCKED
                      </span>
                    )}
                  </div>
                  <p className="mb-2 text-[13px] font-medium leading-snug tracking-tight">
                    {c.title}
                  </p>
                  {c.labels.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {c.labels.map((l) => (
                        <span
                          key={l.t}
                          className="rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                          style={{ background: l.bg, color: l.fg }}
                        >
                          {l.t}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Avatar initials={c.av} size={21} className="text-[9px]" />
                    <span
                      className="font-mono text-[10px]"
                      style={{ color: c.dueColor }}
                    >
                      {c.due}
                    </span>
                    <span className="ml-auto flex items-center gap-2 text-[10.5px] text-text-3">
                      <span>◵ {c.comments}</span>
                      <span className="rounded bg-surface-3 px-1 py-px font-mono font-semibold">
                        {c.points}
                      </span>
                    </span>
                  </div>
                </button>
              ))}
              {col.isBacklog && (
                <button className="rounded-[9px] border border-dashed border-border-2 p-1.5 text-xs text-text-3 hover:bg-surface hover:text-text-2">
                  + Tambah tiket
                </button>
              )}
            </div>
          </div>
        ))}
        <button className="w-[200px] flex-none rounded-[10px] border border-dashed border-border-2 p-3 text-left text-[12.5px] leading-relaxed text-text-3 hover:bg-surface hover:text-text-2">
          + Kolom baru
          <br />
          <span className="text-[11px]">alur saat ini: Backlog → To Do → In Progress → Review → Done</span>
        </button>
      </div>
    </div>
  );
}
