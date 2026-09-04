import { createFileRoute, useRouter, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  DndContext,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Badge } from "@kompast/ui/Badge";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { Tabs } from "@kompast/ui/Tabs";
import { getProjectBoardFn } from "@/lib/server-fns/projects";
import { moveIssueFn, createIssueFn } from "@/lib/server-fns/issues";
import { listProjectPagesFn, createPageFn } from "@/lib/server-fns/pages";
import {
  listSprintsFn,
  listBacklogFn,
  getSprintDetailFn,
  createSprintFn,
  startSprintFn,
  completeSprintFn,
  addIssueToSprintFn,
  removeIssueFromSprintFn,
} from "@/lib/server-fns/sprints";
import { getRoadmapFn } from "@/lib/server-fns/roadmap";
import { TableView } from "@/components/board/TableView";
import { DocsTree } from "@/components/docs/DocsTree";

export const Route = createFileRoute("/_app/projects/$projectKey")({
  loader: ({ params }) => getProjectBoardFn({ data: params.projectKey }),
  component: ProjectPage,
});

const VIEW_TABS = [
  { key: "board", label: "Board", icon: "◫" },
  { key: "sprint", label: "Sprint", icon: "⚑" },
  { key: "table", label: "Tabel", icon: "▤" },
  { key: "roadmap", label: "Roadmap", icon: "▬" },
  { key: "docs", label: "Docs", icon: "▤" },
  { key: "automation", label: "Otomasi", icon: "⚡" },
];

function ProjectPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const [view, setView] = useState("board");
  const [addingIssue, setAddingIssue] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const defaultType = data.issueTypes.find((t) => !t.isSubtask);
  const backlogColumn = data.columns.find((c) => c.isBacklog) ?? data.columns[0];

  async function submitNewIssue() {
    if (!newTitle.trim() || !defaultType || !backlogColumn?.statusIds[0]) return;
    setCreating(true);
    try {
      await createIssueFn({
        data: {
          projectId: data.project.id,
          typeId: defaultType.id,
          statusId: backlogColumn.statusIds[0],
          title: newTitle.trim(),
        },
      });
      setNewTitle("");
      setAddingIssue(false);
      await router.invalidate();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="border-b border-border bg-surface-2 px-6 pt-5">
        <div className="flex items-start gap-3.5">
          <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-indigo text-[13px] font-bold text-white">
            {data.project.key.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="mb-1 text-xl font-semibold tracking-tight">{data.project.name}</h1>
            <p className="text-xs text-text-2">
              {data.project.key} · {data.columns.reduce((n, c) => n + c.issues.length, 0)} tiket
            </p>
          </div>
          <div className="flex gap-1.5">
            {addingIssue ? (
              <>
                <input
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitNewIssue();
                    if (e.key === "Escape") setAddingIssue(false);
                  }}
                  placeholder="Judul tiket…"
                  className="rounded-[7px] border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
                />
                <Button variant="primary" className="text-[12.5px]" onClick={submitNewIssue} disabled={creating}>
                  Simpan
                </Button>
                <Button variant="outline" className="text-[12.5px]" onClick={() => setAddingIssue(false)}>
                  Batal
                </Button>
              </>
            ) : (
              <Button variant="primary" className="text-[12.5px]" onClick={() => setAddingIssue(true)}>
                + Tiket baru
              </Button>
            )}
          </div>
        </div>
        <Tabs items={VIEW_TABS} active={view} onChange={setView} className="mt-4" />
      </div>

      {view === "board" && <BoardView data={data} />}
      {view === "sprint" && <SprintTab projectId={data.project.id} boardId={data.board.id} />}
      {view === "table" && <TableView data={data} />}
      {view === "roadmap" && <RoadmapTab projectId={data.project.id} projectKey={data.project.key} />}
      {view === "docs" && <ProjectDocsTab projectId={data.project.id} />}
      {view !== "board" && view !== "sprint" && view !== "table" && view !== "roadmap" && view !== "docs" && (
        <div className="p-10 text-center text-sm text-text-3">
          Mode <strong className="text-text-2">{VIEW_TABS.find((t) => t.key === view)?.label}</strong>{" "}
          belum dibangun — lihat fase di plan (Timeline: P3+, Otomasi: P6).
        </div>
      )}
    </div>
  );
}

type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;

const PRIORITY_COLOR: Record<string, string> = {
  highest: "var(--accent)",
  high: "var(--amber)",
  medium: "var(--text-3)",
  low: "var(--text-3)",
  lowest: "var(--text-3)",
};

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function ProjectDocsTab({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const [pages, setPages] = useState<Awaited<ReturnType<typeof listProjectPagesFn>> | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listProjectPagesFn({ data: projectId }).then(setPages);
  }, [projectId]);

  async function newPage() {
    setCreating(true);
    try {
      const page = await createPageFn({ data: { projectId } });
      await navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="px-6 py-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-[12.5px] text-text-3">Halaman docs yang ditautkan ke proyek ini.</p>
        <Button variant="primary" className="text-[12.5px]" onClick={newPage} disabled={creating}>
          + Halaman baru
        </Button>
      </div>
      {pages === null ? (
        <p className="text-sm text-text-3">Memuat…</p>
      ) : pages.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-3">
          Belum ada halaman docs untuk proyek ini.
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface p-2">
          <DocsTree pages={pages} />
        </div>
      )}
    </div>
  );
}

type SprintSummary = Awaited<ReturnType<typeof listSprintsFn>>[number];
type BacklogIssue = Awaited<ReturnType<typeof listBacklogFn>>[number];
type SprintDetail = Awaited<ReturnType<typeof getSprintDetailFn>>;

const SPRINT_STATE_LABEL: Record<string, string> = { future: "Belum mulai", active: "Berjalan", closed: "Selesai" };

function SprintTab({ projectId, boardId }: { projectId: string; boardId: string }) {
  const [sprints, setSprints] = useState<SprintSummary[] | null>(null);
  const [backlog, setBacklog] = useState<BacklogIssue[] | null>(null);
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SprintDetail | null>(null);
  const [newSprintName, setNewSprintName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refreshSprints() {
    const list = await listSprintsFn({ data: boardId });
    setSprints(list);
    return list;
  }

  useEffect(() => {
    refreshSprints().then((list) => {
      const active = list.find((s) => s.state === "active");
      setSelectedSprintId((current) => current ?? active?.id ?? list[0]?.id ?? null);
    });
    listBacklogFn({ data: projectId }).then(setBacklog);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, boardId]);

  useEffect(() => {
    if (!selectedSprintId) {
      setDetail(null);
      return;
    }
    getSprintDetailFn({ data: selectedSprintId }).then(setDetail);
  }, [selectedSprintId]);

  async function refreshAll() {
    await Promise.all([refreshSprints(), listBacklogFn({ data: projectId }).then(setBacklog)]);
    if (selectedSprintId) setDetail(await getSprintDetailFn({ data: selectedSprintId }));
  }

  async function createSprint() {
    if (!newSprintName.trim()) return;
    setCreating(true);
    try {
      const { sprintId } = await createSprintFn({ data: { boardId, name: newSprintName.trim(), cycle: "2w" } });
      setNewSprintName("");
      await refreshSprints();
      setSelectedSprintId(sprintId);
    } finally {
      setCreating(false);
    }
  }

  async function handleStart() {
    if (!selectedSprintId) return;
    setBusy(true);
    try {
      await startSprintFn({ data: selectedSprintId });
      await refreshAll();
    } finally {
      setBusy(false);
    }
  }

  async function handleComplete() {
    if (!selectedSprintId) return;
    setBusy(true);
    try {
      await completeSprintFn({ data: { sprintId: selectedSprintId } });
      await refreshAll();
    } finally {
      setBusy(false);
    }
  }

  async function addToSprint(issueId: string) {
    if (!selectedSprintId) return;
    setBusy(true);
    try {
      await addIssueToSprintFn({ data: { sprintId: selectedSprintId, issueId } });
      await refreshAll();
    } finally {
      setBusy(false);
    }
  }

  async function removeFromSprint(issueId: string) {
    setBusy(true);
    try {
      await removeIssueFromSprintFn({ data: issueId });
      await refreshAll();
    } finally {
      setBusy(false);
    }
  }

  if (sprints === null || backlog === null) {
    return <p className="p-6 text-sm text-text-3">Memuat…</p>;
  }

  const sprint = detail?.sprint;

  return (
    <div className="grid grid-cols-2 gap-4 p-6">
      <div className="col-span-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3">
        <select
          value={selectedSprintId ?? ""}
          onChange={(e) => setSelectedSprintId(e.target.value || null)}
          className="rounded-[7px] border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
        >
          <option value="" disabled>
            Pilih sprint…
          </option>
          {sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {SPRINT_STATE_LABEL[s.state]}
            </option>
          ))}
        </select>
        <input
          value={newSprintName}
          onChange={(e) => setNewSprintName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createSprint()}
          placeholder="Nama sprint baru…"
          className="flex-1 rounded-[7px] border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
        />
        <Button variant="outline" className="text-[12.5px]" onClick={createSprint} disabled={creating}>
          + Sprint
        </Button>

        {sprint && (
          <div className="ml-auto flex items-center gap-2">
            {sprint.state === "future" && (
              <Button variant="primary" className="text-[12.5px]" onClick={handleStart} disabled={busy}>
                Mulai sprint
              </Button>
            )}
            {sprint.state === "active" && (
              <Button variant="primary" className="text-[12.5px]" onClick={handleComplete} disabled={busy}>
                Selesaikan sprint
              </Button>
            )}
          </div>
        )}
      </div>

      {sprint && detail && (
        <div className="col-span-2 flex items-center gap-4 rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-[12px] text-text-2">
          <span>
            Scope: <strong>{detail.report.scopeIssueCount}</strong> tiket / <strong>{detail.report.scopePoints}</strong> poin
          </span>
          <span>
            Selesai: <strong>{detail.report.completedIssueCount}</strong> tiket / <strong>{detail.report.completedPoints}</strong> poin
          </span>
          <span>
            Sisa: <strong>{detail.report.remainingPoints}</strong> poin
          </span>
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-text-3">Backlog</p>
        <div className="flex flex-col gap-1.5">
          {backlog.length === 0 && <p className="text-[12.5px] text-text-3">Backlog kosong.</p>}
          {backlog.map((issue) => (
            <div key={issue.id} className="flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5">
              <span className="truncate text-[12.5px]">{issue.title}</span>
              <Button
                variant="outline"
                className="text-[11px]"
                disabled={!selectedSprintId || sprint?.state === "closed" || busy}
                onClick={() => addToSprint(issue.id)}
              >
                + Sprint
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-text-3">Isi sprint</p>
        <div className="flex flex-col gap-1.5">
          {(!detail || detail.issues.length === 0) && <p className="text-[12.5px] text-text-3">Belum ada tiket di sprint ini.</p>}
          {detail?.issues.map((issue) => (
            <div key={issue.id} className="flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5">
              <span className="truncate text-[12.5px]">{issue.title}</span>
              <Button variant="outline" className="text-[11px]" disabled={busy} onClick={() => removeFromSprint(issue.id)}>
                Keluarkan
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type RoadmapEpic = Awaited<ReturnType<typeof getRoadmapFn>>[number];

function RoadmapTab({ projectId, projectKey }: { projectId: string; projectKey: string }) {
  const [epics, setEpics] = useState<RoadmapEpic[] | null>(null);

  useEffect(() => {
    getRoadmapFn({ data: projectId }).then(setEpics);
  }, [projectId]);

  if (epics === null) return <p className="p-6 text-sm text-text-3">Memuat…</p>;

  if (epics.length === 0) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-text-3">
          Belum ada epic. Buat tiket bertipe "Epic" lalu tautkan tiket lain ke epic tersebut untuk melihat roadmap.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 p-6">
      {epics.map((epic) => {
        const pct = epic.childCount === 0 ? 0 : Math.round((epic.doneCount / epic.childCount) * 100);
        return (
          <div key={epic.id} className="rounded-xl border border-border bg-surface p-3.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="font-mono text-[10.5px] text-text-3">
                {projectKey}-{epic.keySeq}
              </span>
              <span className="text-[13px] font-semibold tracking-tight">{epic.title}</span>
              <span className="ml-auto text-[11.5px] text-text-3">
                {epic.startDate ? new Date(epic.startDate).toLocaleDateString("id-ID", { day: "numeric", month: "short" }) : "?"} –{" "}
                {epic.dueDate ? new Date(epic.dueDate).toLocaleDateString("id-ID", { day: "numeric", month: "short" }) : "?"}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--violet)" }} />
            </div>
            <p className="mt-1 text-[11px] text-text-3">
              {epic.doneCount}/{epic.childCount} tiket selesai ({pct}%)
            </p>
          </div>
        );
      })}
    </div>
  );
}

function BoardView({ data }: { data: BoardData }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const usersById = new Map(data.users.map((u) => [u.id, u]));
  const issueTypesById = new Map(data.issueTypes.map((t) => [t.id, t]));

  const needle = search.trim().toLowerCase();
  const columns = needle
    ? data.columns.map((col) => ({
        ...col,
        issues: col.issues.filter(
          (i) => i.title.toLowerCase().includes(needle) || `${data.project.key}-${i.keySeq}`.toLowerCase().includes(needle),
        ),
      }))
    : data.columns;

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    // Dropping onto a column's empty area moves to the end of that column;
    // dropping onto a specific card inserts before it. Both are encoded as
    // droppable ids so a single handler covers both without extra state.
    const overColumn = data.columns.find((c) => c.id === overId);
    const overIsCard = data.columns.some((c) => c.issues.some((i) => i.id === overId));

    let toStatusId: string | undefined;
    let beforeIssueId: string | undefined;
    let afterIssueId: string | undefined;

    if (overColumn) {
      toStatusId = overColumn.statusIds[0];
      afterIssueId = overColumn.issues.at(-1)?.id;
    } else if (overIsCard) {
      const targetColumn = data.columns.find((c) => c.issues.some((i) => i.id === overId))!;
      toStatusId = targetColumn.statusIds[0];
      beforeIssueId = overId;
    } else {
      return;
    }
    if (!toStatusId) return;

    setPending(true);
    try {
      await moveIssueFn({ data: { issueId: activeId, toStatusId, beforeIssueId, afterIssueId } });
      await router.invalidate();
    } finally {
      setPending(false);
    }
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2.5">
          <div className="flex w-[190px] items-center gap-1.5 rounded-[7px] border border-border bg-surface px-2.5 py-1.5">
            <span className="text-[11px] text-text-3">⌕</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari di board"
              className="min-w-0 flex-1 border-none bg-transparent text-[12.5px] outline-none placeholder:text-text-3"
            />
          </div>
          <div className="ml-auto flex items-center gap-2 text-[11.5px] text-text-3">
            {pending ? "Menyimpan…" : null}
          </div>
        </div>

        <div
          className="flex min-h-[calc(100vh-200px)] items-start gap-3.5 overflow-x-auto px-6 pb-7 pt-4"
          style={{
            backgroundImage: "radial-gradient(var(--grid) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        >
          {columns.map((col) => (
            <Column
              key={col.id}
              column={col}
              projectKey={data.project.key}
              issueTypesById={issueTypesById}
              usersById={usersById}
            />
          ))}
        </div>
      </div>
    </DndContext>
  );
}

function Column({
  column,
  projectKey,
  issueTypesById,
  usersById,
}: {
  column: BoardData["columns"][number];
  projectKey: string;
  issueTypesById: Map<string, BoardData["issueTypes"][number]>;
  usersById: Map<string, BoardData["users"][number]>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div className="flex w-[274px] flex-none flex-col gap-2.5">
      <div className="flex items-center gap-2 px-0.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: column.color }} />
        <span className="text-[12.5px] font-semibold tracking-tight">{column.name}</span>
        <span className="font-mono text-[10.5px] text-text-3">{column.issues.length}</span>
        {column.isBacklog && <Badge>tetap</Badge>}
        {column.wipLimit != null && column.issues.length > column.wipLimit && (
          <span className="ml-auto text-[10px] font-semibold text-amber">
            {column.issues.length}/{column.wipLimit}
          </span>
        )}
      </div>

      <div
        ref={setNodeRef}
        className="flex min-h-[40px] flex-col gap-2 rounded-lg"
        style={isOver ? { background: "var(--surface-3)" } : undefined}
      >
        {column.issues.map((issue) => (
          <Card key={issue.id} issue={issue} projectKey={projectKey} issueTypesById={issueTypesById} usersById={usersById} />
        ))}
      </div>
    </div>
  );
}

function Card({
  issue,
  projectKey,
  issueTypesById,
  usersById,
}: {
  issue: BoardData["columns"][number]["issues"][number];
  projectKey: string;
  issueTypesById: Map<string, BoardData["issueTypes"][number]>;
  usersById: Map<string, BoardData["users"][number]>;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: issue.id });
  const type = issueTypesById.get(issue.typeId);
  const assignee = issue.assigneeId ? usersById.get(issue.assigneeId) : undefined;

  return (
    <Link
      to="/issues/$projectKey/$issueKeySeq"
      params={{ projectKey, issueKeySeq: String(issue.keySeq) }}
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="block w-full rounded-[10px] border border-border bg-surface p-2.5 text-left hover:border-border-2 hover:shadow-kp"
      style={{
        opacity: isDragging ? 0.4 : 1,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="font-mono text-[10px] font-medium text-text-3">
          {projectKey}-{issue.keySeq}
        </span>
        {type && (
          <span
            className="rounded px-1 py-px text-[9.5px] font-bold uppercase tracking-[0.03em]"
            style={{ background: "var(--surface-3)", color: "var(--text-2)" }}
          >
            {type.name}
          </span>
        )}
      </div>
      <p className="mb-2 text-[13px] font-medium leading-snug tracking-tight">{issue.title}</p>
      {issue.labels.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {issue.labels.map((label) => (
            <span key={label} className="rounded bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium text-text-2">
              {label}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        {assignee && <Avatar initials={initialsOf(assignee.name)} size={21} className="text-[9px]" />}
        {issue.dueDate && (
          <span className="font-mono text-[10px]" style={{ color: PRIORITY_COLOR[issue.priority] }}>
            {new Date(issue.dueDate).toLocaleDateString("id-ID", { day: "numeric", month: "short" })}
          </span>
        )}
        {issue.storyPoints != null && (
          <span className="ml-auto rounded bg-surface-3 px-1 py-px font-mono text-[10.5px] font-semibold text-text-3">
            {issue.storyPoints}
          </span>
        )}
      </div>
    </Link>
  );
}
