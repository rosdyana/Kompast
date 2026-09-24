import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ChevronRight, Filter, GripVertical, MoreHorizontal, Plus, Sparkles, X } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { Avatar, UnassignedAvatar } from "@kompast/ui/Avatar";
import { Badge } from "@kompast/ui/Badge";
import { IssueTypeIcon } from "@kompast/ui/IssueTypeIcon";
import { Popover } from "@kompast/ui/Popover";
import { MenuItem, MenuLabel, MenuList, MenuSeparator } from "@kompast/ui/Menu";
import { SelectMenu } from "@kompast/ui/SelectMenu";
import { Dialog } from "@kompast/ui/Dialog";
import { NativeSelect, SearchField } from "@kompast/ui/Input";
import { EmptyState, SkeletonRows, Spinner } from "@kompast/ui/EmptyState";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation } from "@kompast/i18n";
import { moveIssueFn, createIssueFn } from "@/lib/server-fns/issues";
import { updateIssueAssigneeFn, updateIssuePriorityFn, updateIssueStoryPointsFn } from "@/lib/server-fns/issue-detail";
import {
  listSprintsFn,
  listBacklogFn,
  getSprintDetailFn,
  createSprintFn,
  updateSprintFn,
  startSprintFn,
  completeSprintFn,
  addIssueToSprintFn,
  removeIssueFromSprintFn,
} from "@/lib/server-fns/sprints";
import { streamAiCompletion } from "@/lib/ai-stream-client";
import { cn } from "@/lib/cn";
import { AssigneePicker, PointsPill, PriorityPicker, StatusPicker } from "./IssuePickers";
import {
  daysUntil,
  formatShortDate,
  useIntlLocale,
  useProjectLookups,
  useSuppressClickAfterDrag,
  type BoardData,
} from "./project-shared";

type Sprint = Awaited<ReturnType<typeof listSprintsFn>>[number];

interface Row {
  id: string;
  keySeq: number;
  typeId: string;
  statusId: string;
  title: string;
  assigneeId: string | null;
  epicId: string | null;
  priority: string;
  storyPoints: number | null;
}

const BACKLOG = "backlog";

function toRow(i: Row): Row {
  return {
    id: i.id,
    keySeq: i.keySeq,
    typeId: i.typeId,
    statusId: i.statusId,
    title: i.title,
    assigneeId: i.assigneeId,
    epicId: i.epicId,
    priority: i.priority,
    storyPoints: i.storyPoints,
  };
}

export function BacklogView({ data, teamId }: { data: BoardData; teamId: string }) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const toast = useToast();
  const locale = useIntlLocale();
  const lookups = useProjectLookups(data.project.id);
  const projectKey = data.project.key;
  const boardId = data.board.id;
  const projectId = data.project.id;

  const [sprints, setSprints] = useState<Sprint[] | null>(null);
  const [lists, setLists] = useState<Record<string, Row[]> | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeMenuRef = useRef<HTMLButtonElement>(null);
  const [completing, setCompleting] = useState<Sprint | null>(null);
  const [aiFor, setAiFor] = useState<string | null>(null);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const suppress = useSuppressClickAfterDrag();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const refreshId = useRef(0);

  const typesById = useMemo(() => new Map(data.issueTypes.map((tp) => [tp.id, tp])), [data.issueTypes]);
  const epicsById = useMemo(() => new Map(data.candidateEpics.map((e) => [e.id, e])), [data.candidateEpics]);
  const priorityLevels = useMemo(() => [...data.priorityLevels].sort((a, b) => a.order - b.order), [data.priorityLevels]);
  const defaultType = data.issueTypes.find((tp) => !tp.isSubtask && tp.hierarchyLevel !== 0);

  async function refresh() {
    const id = ++refreshId.current;
    const [list, backlog] = await Promise.all([listSprintsFn({ data: boardId }), listBacklogFn({ data: projectId })]);
    const open = list.filter((s) => s.state !== "closed");
    const details = await Promise.all(open.map((s) => getSprintDetailFn({ data: s.id }).then((d) => [s.id, d.issues.map(toRow)] as const)));
    if (id !== refreshId.current) return;
    setSprints(list);
    setLists({ [BACKLOG]: backlog.map(toRow), ...Object.fromEntries(details) });
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : t("genericError")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, boardId]);

  /** Apply `optimistic` locally now, run `fn`, then reconcile with the server either way. */
  async function mutate(optimistic: ((prev: Record<string, Row[]>) => Record<string, Row[]>) | null, fn: () => Promise<unknown>) {
    if (optimistic) setLists((prev) => (prev ? optimistic(prev) : prev));
    setPending((n) => n + 1);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      try {
        await refresh();
      } catch {
        /* keep last good data */
      }
      setPending((n) => n - 1);
      router.invalidate();
    }
  }

  const patchRow = (issueId: string, patch: Partial<Row>) => (prev: Record<string, Row[]>) =>
    Object.fromEntries(Object.entries(prev).map(([k, rows]) => [k, rows.map((r) => (r.id === issueId ? { ...r, ...patch } : r))]));

  function containerOf(issueId: string): string | null {
    if (!lists) return null;
    for (const [k, rows] of Object.entries(lists)) if (rows.some((r) => r.id === issueId)) return k;
    return null;
  }

  function moveBetween(issueId: string, target: string) {
    const source = containerOf(issueId);
    if (!source || source === target) return;
    mutate(
      (prev) => {
        const row = prev[source]?.find((r) => r.id === issueId);
        if (!row) return prev;
        return { ...prev, [source]: prev[source]!.filter((r) => r.id !== issueId), [target]: [...(prev[target] ?? []), row] };
      },
      () => (target === BACKLOG ? removeIssueFromSprintFn({ data: issueId }) : addIssueToSprintFn({ data: { sprintId: target, issueId } })),
    );
  }

  function reorderBacklog(activeId: string, overId: string) {
    const rows = lists?.[BACKLOG];
    if (!rows) return;
    const from = rows.findIndex((r) => r.id === activeId);
    const to = rows.findIndex((r) => r.id === overId);
    if (from < 0 || to < 0 || from === to) return;
    const without = rows.filter((r) => r.id !== activeId);
    const targetIdx = without.findIndex((r) => r.id === overId);
    // Moving down lands after the target row, moving up lands before it.
    const insertAt = from < to ? targetIdx + 1 : targetIdx;
    const next = [...without.slice(0, insertAt), rows[from]!, ...without.slice(insertAt)];
    const predecessor = next[insertAt - 1]?.id;
    const successor = next[insertAt + 1]?.id;
    mutate(
      (prev) => ({ ...prev, [BACKLOG]: next }),
      () => moveIssueFn({ data: { issueId: activeId, toStatusId: rows[from]!.statusId, beforeIssueId: predecessor, afterIssueId: successor } }),
    );
  }

  function handleDragStart(e: DragStartEvent) {
    suppress.arm();
    setActiveDragId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveDragId(null);
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;
    if (overId.startsWith("container:")) {
      moveBetween(activeId, overId.slice("container:".length));
      return;
    }
    if (overId.startsWith("row:")) {
      const targetIssue = overId.slice("row:".length);
      if (targetIssue === activeId) return;
      const source = containerOf(activeId);
      const target = containerOf(targetIssue);
      if (!target) return;
      if (source === target) {
        if (target === BACKLOG) reorderBacklog(activeId, targetIssue);
      } else moveBetween(activeId, target);
    }
  }

  async function createInContainer(container: string, title: string) {
    if (!defaultType) return;
    await mutate(null, async () => {
      const created = await createIssueFn({
        data: { projectId, typeId: defaultType.id, title, sprintId: container === BACKLOG ? undefined : container },
      });
      toast.show({ title: t("backlog.createdToast", { key: `${projectKey}-${created.keySeq}` }), description: title });
    });
  }

  async function generateSummary(sprintId: string) {
    setAiFor(sprintId);
    setAiBusy(true);
    setAiError(null);
    setAiText("");
    try {
      await streamAiCompletion({ feature: "sprint-summary", sprintId }, (delta) => setAiText((prev) => (prev ?? "") + delta));
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t("sprint.aiSummaryFailed"));
    } finally {
      setAiBusy(false);
    }
  }

  // ---- filters -------------------------------------------------------------
  const needle = search.trim().toLowerCase();
  const filterRow = (r: Row) =>
    (!needle || r.title.toLowerCase().includes(needle) || `${projectKey}-${r.keySeq}`.toLowerCase().includes(needle)) &&
    (assigneeFilter.size === 0 || assigneeFilter.has(r.assigneeId ?? "__none")) &&
    (typeFilter.length === 0 || typeFilter.includes(r.typeId));
  const filtersActive = needle !== "" || assigneeFilter.size > 0 || typeFilter.length > 0;

  const allRows = lists ? Object.values(lists).flat() : [];
  const assigneeIdsInUse = [...new Set(allRows.map((r) => r.assigneeId).filter((x): x is string => !!x))];
  const hasUnassigned = allRows.some((r) => !r.assigneeId);

  function toggleAssignee(key: string) {
    setAssigneeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (sprints === null || lists === null) {
    return (
      <div className="p-6">
        {error ? <p className="rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{error}</p> : <SkeletonRows rows={6} />}
      </div>
    );
  }

  const activeSprints = sprints.filter((s) => s.state === "active");
  const futureSprints = sprints.filter((s) => s.state === "future").sort((a, b) => a.number - b.number);
  const openSprints = [...activeSprints, ...futureSprints];
  const hasActive = activeSprints.length > 0;
  const activeRow = activeDragId ? allRows.find((r) => r.id === activeDragId) : undefined;

  const rowProps = {
    projectKey,
    teamId,
    typesById,
    epicsById,
    priorityLevels,
    lookups,
    containers: openSprints,
    onStatus: (id: string, statusId: string) => mutate(patchRow(id, { statusId }), () => moveIssueFn({ data: { issueId: id, toStatusId: statusId } })),
    onAssignee: (id: string, assigneeId: string | null) =>
      mutate(patchRow(id, { assigneeId }), () => updateIssueAssigneeFn({ data: { issueId: id, assigneeId } })),
    onPriority: (id: string, priority: string) => mutate(patchRow(id, { priority }), () => updateIssuePriorityFn({ data: { issueId: id, priority } })),
    onPoints: (id: string, storyPoints: number | null) =>
      mutate(patchRow(id, { storyPoints }), () => updateIssueStoryPointsFn({ data: { issueId: id, storyPoints } })),
    onMove: moveBetween,
  };

  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveDragId(null)}>
      <div className="kp-backlog flex flex-col gap-4 px-4 pb-16 pt-4 sm:px-6">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <SearchField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch("")}
            clearLabel={t("backlog.clearFilters")}
            placeholder={t("backlog.searchPlaceholder")}
            aria-label={t("backlog.searchPlaceholder")}
            wrapperClassName="w-full sm:w-[240px]"
          />
          {(assigneeIdsInUse.length > 0 || hasUnassigned) && (
            <div className="flex items-center pl-1" role="group" aria-label={t("backlog.quickFilters")}>
              {assigneeIdsInUse.map((id) => {
                const name = lookups.membersById.get(id)?.name ?? data.users.find((u) => u.id === id)?.name ?? "?";
                const on = assigneeFilter.has(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggleAssignee(id)}
                    aria-pressed={on}
                    title={name}
                    className={cn(
                      "-ml-1 rounded-full ring-2 transition-transform first:ml-0 hover:z-10 hover:-translate-y-0.5",
                      on ? "z-10 ring-accent" : "ring-bg",
                    )}
                  >
                    <Avatar name={name} size={28} />
                  </button>
                );
              })}
              {hasUnassigned && (
                <button
                  type="button"
                  onClick={() => toggleAssignee("__none")}
                  aria-pressed={assigneeFilter.has("__none")}
                  title={t("backlog.unassigned")}
                  className={cn("-ml-1 rounded-full ring-2 hover:z-10", assigneeFilter.has("__none") ? "z-10 ring-accent" : "ring-bg")}
                >
                  <UnassignedAvatar size={28} />
                </button>
              )}
            </div>
          )}
          <Button ref={typeMenuRef} variant={typeFilter.length ? "secondary" : "ghost"} size="sm" onClick={() => setTypeMenuOpen(!typeMenuOpen)}>
            <Filter size={14} />
            {t("backlog.typeFilter")}
            {typeFilter.length > 0 && <Badge tone="accent">{typeFilter.length}</Badge>}
          </Button>
          <SelectMenu
            multiple
            open={typeMenuOpen}
            onClose={() => setTypeMenuOpen(false)}
            anchorRef={typeMenuRef}
            options={data.issueTypes.map((tp) => ({ value: tp.id, label: tp.name, icon: <IssueTypeIcon type={tp} size={16} /> }))}
            values={typeFilter}
            onToggle={(v) => setTypeFilter((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))}
          />
          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setAssigneeFilter(new Set());
                setTypeFilter([]);
              }}
            >
              {t("backlog.clearFilters")}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2 type-small text-text-3" aria-live="polite">
            {pending > 0 && (
              <>
                <Spinner size={12} /> {t("savingEllipsis")}
              </>
            )}
          </div>
        </div>

        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </p>
        )}

        {openSprints.map((sprint) => {
          const rows = lists[sprint.id] ?? [];
          return (
            <Container
              key={sprint.id}
              id={sprint.id}
              collapsed={collapsed.has(sprint.id)}
              onToggle={() => toggleCollapsed(sprint.id)}
              header={
                <SprintHeader
                  sprint={sprint}
                  rows={rows}
                  locale={locale}
                  statusesById={lookups.statusesById}
                  hasOtherActive={hasActive && sprint.state !== "active"}
                  onRename={(name) => mutate(null, () => updateSprintFn({ data: { sprintId: sprint.id, name } }))}
                  onStart={() => mutate(null, () => startSprintFn({ data: sprint.id }))}
                  onComplete={() => setCompleting(sprint)}
                  onAiSummary={() => generateSummary(sprint.id)}
                  disabled={pending > 0}
                />
              }
              footer={<CreateRow onCreate={(title) => createInContainer(sprint.id, title)} disabled={!defaultType} />}
            >
              {aiFor === sprint.id && (
                <div className="mx-3 mb-2 rounded-[8px] border border-border bg-surface-2 px-3 py-2.5">
                  <div className="mb-1 flex items-center gap-2">
                    <Sparkles size={14} className="text-violet" />
                    <span className="text-[13px] font-medium">{t("backlog.aiSummary")}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button variant="ghost" size="xs" onClick={() => generateSummary(sprint.id)} disabled={aiBusy}>
                        {aiBusy ? t("sprint.writingEllipsis") : t("backlog.regenerate")}
                      </Button>
                      <IconButton size="xs" aria-label="Close" onClick={() => setAiFor(null)}>
                        <X size={13} />
                      </IconButton>
                    </div>
                  </div>
                  {aiError ? (
                    <p className="type-small text-danger">{aiError}</p>
                  ) : (
                    <p className="whitespace-pre-wrap type-small text-text-2">{aiText || (aiBusy ? "…" : t("backlog.summaryEmpty"))}</p>
                  )}
                </div>
              )}
              <RowList rows={rows.filter(filterRow)} empty={filtersActive && rows.length ? t("backlog.noMatches") : t("backlog.emptySprint")} {...rowProps} />
            </Container>
          );
        })}

        <Container
          id={BACKLOG}
          collapsed={collapsed.has(BACKLOG)}
          onToggle={() => toggleCollapsed(BACKLOG)}
          header={
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-[14px] font-semibold text-text">{t("sprint.backlogHeading")}</span>
              <span className="type-small text-text-3">{t("backlog.issueCount", { count: lists[BACKLOG]?.length ?? 0 })}</span>
              <PointTotals rows={lists[BACKLOG] ?? []} statusesById={lookups.statusesById} />
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={pending > 0}
                onClick={() => mutate(null, () => createSprintFn({ data: { boardId } }))}
              >
                {t("sprint.createSprintButton")}
              </Button>
            </div>
          }
          footer={<CreateRow onCreate={(title) => createInContainer(BACKLOG, title)} disabled={!defaultType} />}
        >
          <RowList
            rows={(lists[BACKLOG] ?? []).filter(filterRow)}
            empty={filtersActive && (lists[BACKLOG]?.length ?? 0) > 0 ? t("backlog.noMatches") : t("backlog.emptyBacklog")}
            {...rowProps}
          />
        </Container>
      </div>

      <DragOverlay dropAnimation={null}>
        {activeRow ? (
          <div className="flex h-10 cursor-grabbing items-center gap-2.5 rounded-[6px] border border-border bg-surface px-3 shadow-lift">
            <IssueTypeIcon type={typesById.get(activeRow.typeId)} size={16} />
            <span className="type-key text-text-3">
              {projectKey}-{activeRow.keySeq}
            </span>
            <span className="truncate text-[14px]">{activeRow.title}</span>
          </div>
        ) : null}
      </DragOverlay>

      <CompleteSprintDialog
        sprint={completing}
        rows={completing ? (lists[completing.id] ?? []) : []}
        futureSprints={futureSprints}
        statusesById={lookups.statusesById}
        onClose={() => setCompleting(null)}
        onConfirm={async (carryToSprintId) => {
          const sprint = completing;
          setCompleting(null);
          if (sprint) await mutate(null, () => completeSprintFn({ data: { sprintId: sprint.id, carryToSprintId } }));
        }}
      />
    </DndContext>
  );
}

// ---- containers --------------------------------------------------------------

function Container({
  id,
  header,
  footer,
  children,
  collapsed,
  onToggle,
}: {
  id: string;
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("board");
  const { setNodeRef, isOver } = useDroppable({ id: `container:${id}` });
  return (
    <section
      ref={setNodeRef}
      className={cn(
        "rounded-[10px] border bg-surface-2 transition-colors",
        isOver ? "border-accent bg-accent-soft/40" : "border-border",
      )}
    >
      <div className="flex min-h-12 items-center gap-1.5 px-2 py-2 pr-3">
        <IconButton size="xs" onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? t("backlog.expand") : t("backlog.collapse")}>
          <ChevronRight size={15} strokeWidth={2} className={cn("transition-transform", !collapsed && "rotate-90")} />
        </IconButton>
        {header}
      </div>
      {!collapsed && (
        <div className="pb-2">
          {children}
          {footer}
        </div>
      )}
    </section>
  );
}

function PointTotals({ rows, statusesById }: { rows: Row[]; statusesById: Map<string, { category: string }> }) {
  const { t } = useTranslation("board");
  const totals = { todo: 0, in_progress: 0, done: 0 };
  for (const r of rows) {
    const cat = (statusesById.get(r.statusId)?.category ?? "todo") as keyof typeof totals;
    totals[cat] += r.storyPoints ?? 0;
  }
  const pills: { key: keyof typeof totals; label: string; className: string }[] = [
    { key: "todo", label: t("backlog.pointsTodo"), className: "bg-surface-4 text-text-2" },
    { key: "in_progress", label: t("backlog.pointsInProgress"), className: "bg-accent-soft text-accent-text" },
    { key: "done", label: t("backlog.pointsDone"), className: "bg-green-soft text-green" },
  ];
  return (
    <span className="flex items-center gap-1">
      {pills.map((p) => (
        <span
          key={p.key}
          title={t("backlog.pointsTitle", { category: p.label, points: totals[p.key] })}
          className={cn("inline-flex h-5 min-w-[22px] items-center justify-center rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums", p.className)}
        >
          {totals[p.key]}
        </span>
      ))}
    </span>
  );
}

function SprintHeader({
  sprint,
  rows,
  locale,
  statusesById,
  hasOtherActive,
  onRename,
  onStart,
  onComplete,
  onAiSummary,
  disabled,
}: {
  sprint: Sprint;
  rows: Row[];
  locale: string;
  statusesById: Map<string, { category: string }>;
  hasOtherActive: boolean;
  onRename: (name: string) => void;
  onStart: () => void;
  onComplete: () => void;
  onAiSummary: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation("board");
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(sprint.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const start = formatShortDate(sprint.startAt, locale);
  const end = formatShortDate(sprint.endAt, locale);
  const isActive = sprint.state === "active";
  const days = isActive && sprint.endAt ? daysUntil(sprint.endAt) : null;

  function save() {
    setRenaming(false);
    const v = draft.trim();
    if (v && v !== sprint.name) onRename(v);
  }

  const startBlockedReason = hasOtherActive ? t("backlog.startBlockedActive") : rows.length === 0 ? t("backlog.startBlockedEmpty") : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setDraft(sprint.name);
              setRenaming(false);
            }
          }}
          className="kp-field h-7 w-[200px] text-[14px] font-semibold"
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(sprint.name);
            setRenaming(true);
          }}
          title={t("sprint.renameHint")}
          className="rounded-[4px] px-1 text-[14px] font-semibold text-text hover:bg-surface-3"
        >
          {sprint.name}
        </button>
      )}
      <Badge tone={isActive ? "accent" : "neutral"}>{isActive ? t("backlog.activeBadge") : t("backlog.futureBadge")}</Badge>
      <span className="type-small text-text-3">
        {start || end ? `${start ?? "?"} – ${end ?? "?"}` : t("backlog.noDates")}
        {days !== null && (
          <span className={cn("ml-2", days < 0 ? "text-danger" : days <= 2 ? "text-amber" : "")}>
            · {days < 0 ? t("backlog.ended", { date: end }) : t("backlog.daysLeft", { count: days })}
          </span>
        )}
      </span>
      <span className="type-small text-text-3">{t("backlog.issueCount", { count: rows.length })}</span>
      <div className="ml-auto flex items-center gap-1.5">
        <PointTotals rows={rows} statusesById={statusesById} />
        {isActive ? (
          <Button variant="outline" size="sm" onClick={onComplete} disabled={disabled}>
            {t("sprint.complete")}
          </Button>
        ) : (
          <span title={startBlockedReason}>
            <Button variant="primary" size="sm" onClick={onStart} disabled={disabled || !!startBlockedReason}>
              {t("sprint.start")}
            </Button>
          </span>
        )}
        <IconButton ref={menuRef} size="sm" aria-label={t("backlog.sprintMenu")} onClick={() => setMenuOpen(!menuOpen)}>
          <MoreHorizontal size={16} />
        </IconButton>
        <Popover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuRef} placement="bottom-end" role="menu">
          <MenuList>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                setDraft(sprint.name);
                setRenaming(true);
              }}
            >
              {t("backlog.rename")}
            </MenuItem>
            <MenuItem
              icon={<Sparkles size={15} />}
              onClick={() => {
                setMenuOpen(false);
                onAiSummary();
              }}
            >
              {t("backlog.aiSummary")}
            </MenuItem>
          </MenuList>
        </Popover>
      </div>
    </div>
  );
}

// ---- rows ---------------------------------------------------------------------

interface RowCommon {
  projectKey: string;
  teamId: string;
  typesById: Map<string, BoardData["issueTypes"][number]>;
  epicsById: Map<string, BoardData["candidateEpics"][number]>;
  priorityLevels: BoardData["priorityLevels"];
  lookups: ReturnType<typeof useProjectLookups>;
  containers: Sprint[];
  onStatus: (id: string, statusId: string) => void;
  onAssignee: (id: string, assigneeId: string | null) => void;
  onPriority: (id: string, priority: string) => void;
  onPoints: (id: string, points: number | null) => void;
  onMove: (id: string, target: string) => void;
}

function RowList({ rows, empty, ...common }: RowCommon & { rows: Row[]; empty: string }) {
  if (rows.length === 0) {
    return <p className="mx-3 rounded-[6px] border border-dashed border-border-2 px-3 py-4 text-center type-small text-text-3">{empty}</p>;
  }
  return (
    <ul className="mx-3 overflow-hidden rounded-[6px] border border-border bg-surface">
      {rows.map((r) => (
        <IssueRow key={r.id} row={r} {...common} />
      ))}
    </ul>
  );
}

function IssueRow({ row, projectKey, teamId, typesById, epicsById, priorityLevels, lookups, containers, onStatus, onAssignee, onPriority, onPoints, onMove }: RowCommon & { row: Row }) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const drag = useDraggable({ id: row.id });
  const drop = useDroppable({ id: `row:${row.id}` });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const type = typesById.get(row.typeId);
  const epic = row.epicId ? epicsById.get(row.epicId) : undefined;
  const status = lookups.statusesById.get(row.statusId);
  const issueParams = { teamId, projectKey, issueKeySeq: String(row.keySeq) };
  const openIssue = () => router.navigate({ to: "/issues/$teamId/$projectKey/$issueKeySeq", params: issueParams, search: { from: "backlog" } });

  return (
    <li
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.listeners}
      {...drag.attributes}
      onClick={openIssue}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) openIssue();
      }}
      className={cn(
        "group/issue relative flex h-10 cursor-pointer items-center gap-2 border-b border-border px-2 last:border-b-0 hover:bg-surface-2",
        drag.isDragging && "opacity-40",
        drop.isOver && !drag.isDragging && "before:absolute before:inset-x-0 before:top-0 before:h-[2px] before:bg-accent",
      )}
    >
      <GripVertical size={14} aria-label={t("backlog.dragHandle")} className="flex-none cursor-grab text-text-3 opacity-0 group-hover/issue:opacity-100" />
      <IssueTypeIcon type={type} size={16} />
      <Link
        to="/issues/$teamId/$projectKey/$issueKeySeq"
        params={issueParams}
        search={{ from: "backlog" }}
        onClick={(e) => e.stopPropagation()}
        className="type-key flex-none text-text-3 hover:text-accent-text hover:underline"
      >
        {projectKey}-{row.keySeq}
      </Link>
      <span className="min-w-0 flex-1 truncate text-[14px] text-text">{row.title}</span>
      {epic && (
        <span title={epic.title} className="hidden max-w-[160px] flex-none truncate rounded-[4px] bg-violet-soft px-1.5 py-0.5 text-[11.5px] font-medium text-violet md:inline-block">
          {epic.title}
        </span>
      )}
      <StatusPicker status={status} statuses={lookups.statuses} onChange={(s) => onStatus(row.id, s)} />
      <PointsPill value={row.storyPoints} onChange={(v) => onPoints(row.id, v)} className="max-sm:hidden" />
      <span className="hidden sm:inline-flex">
        <PriorityPicker priorityKey={row.priority} levels={priorityLevels} onChange={(p) => onPriority(row.id, p)} />
      </span>
      <AssigneePicker assigneeId={row.assigneeId} members={lookups.members} onChange={(a) => onAssignee(row.id, a)} />
      <IconButton
        ref={menuRef}
        size="xs"
        aria-label={t("backlog.rowMenu")}
        className="opacity-0 focus-visible:opacity-100 group-hover/issue:opacity-100"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen(!menuOpen);
        }}
      >
        <MoreHorizontal size={15} />
      </IconButton>
      <Popover open={menuOpen} onClose={() => setMenuOpen(false)} anchorRef={menuRef} placement="bottom-end" role="menu">
        <MenuList>
          <MenuItem onClick={() => { setMenuOpen(false); openIssue(); }}>{t("backlog.openIssue")}</MenuItem>
          <MenuSeparator />
          <MenuLabel>{t("backlog.moveTo")}</MenuLabel>
          {containers.map((s) => (
            <MenuItem key={s.id} onClick={() => { setMenuOpen(false); onMove(row.id, s.id); }}>
              {s.name}
            </MenuItem>
          ))}
          <MenuItem onClick={() => { setMenuOpen(false); onMove(row.id, BACKLOG); }}>{t("backlog.moveToBacklog")}</MenuItem>
        </MenuList>
      </Popover>
    </li>
  );
}

function CreateRow({ onCreate, disabled }: { onCreate: (title: string) => Promise<void>; disabled?: boolean }) {
  const { t } = useTranslation("board");
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    try {
      await onCreate(v);
      setValue("");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="mx-3 mt-1 flex h-8 w-[calc(100%-24px)] items-center gap-2 rounded-[6px] px-2 text-[13.5px] text-text-2 hover:bg-surface-3 hover:text-text disabled:opacity-50"
      >
        <Plus size={15} /> {t("backlog.createIssueRow")}
      </button>
    );
  }
  return (
    <div className="mx-3 mt-1 flex items-center gap-2">
      <input
        autoFocus
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") {
            setOpen(false);
            setValue("");
          }
        }}
        onBlur={() => !value.trim() && setOpen(false)}
        placeholder={t("backlog.createIssuePlaceholder")}
        className="kp-input h-9"
      />
      {busy && <Spinner size={14} />}
    </div>
  );
}

export function CompleteSprintDialog({
  sprint,
  rows,
  futureSprints,
  statusesById,
  onClose,
  onConfirm,
}: {
  sprint: { id: string; name: string } | null;
  rows: { statusId: string }[];
  futureSprints: { id: string; name: string }[];
  statusesById: Map<string, { category: string }>;
  onClose: () => void;
  onConfirm: (carryToSprintId: string | undefined) => void;
}) {
  const { t } = useTranslation("board");
  const [target, setTarget] = useState("");
  useEffect(() => {
    if (sprint) setTarget(futureSprints[0]?.id ?? "");
  }, [sprint, futureSprints]);
  const done = rows.filter((r) => statusesById.get(r.statusId)?.category === "done").length;
  const open = rows.length - done;

  return (
    <Dialog
      open={!!sprint}
      onClose={onClose}
      size="sm"
      title={sprint ? t("backlog.completeTitle", { name: sprint.name }) : ""}
      description={t("backlog.completeSummary", { done, total: rows.length })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="primary" onClick={() => onConfirm(open > 0 && target ? target : undefined)}>
            {t("backlog.completeButton")}
          </Button>
        </>
      }
    >
      {open > 0 ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-text-2">{t("backlog.completeCarryLabel", { count: open })}</span>
          <NativeSelect value={target} onChange={(e) => setTarget(e.target.value)}>
            {futureSprints.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="">{t("sprint.backlogHeading")}</option>
          </NativeSelect>
        </label>
      ) : (
        <EmptyState variant="plain" className="py-4" title={t("backlog.completeNoOpen")} />
      )}
    </Dialog>
  );
}
