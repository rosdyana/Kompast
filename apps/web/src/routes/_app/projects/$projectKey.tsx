import { createFileRoute, useRouter, Link } from "@tanstack/react-router";
import { useState } from "react";
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
import { TableView } from "@/components/board/TableView";

export const Route = createFileRoute("/_app/projects/$projectKey")({
  loader: ({ params }) => getProjectBoardFn({ data: params.projectKey }),
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
      {view === "table" && <TableView data={data} />}
      {view !== "board" && view !== "table" && (
        <div className="p-10 text-center text-sm text-text-3">
          Mode <strong className="text-text-2">{VIEW_TABS.find((t) => t.key === view)?.label}</strong>{" "}
          belum dibangun — lihat fase di plan (Timeline: P3+, Docs: P2, Otomasi: P6).
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
