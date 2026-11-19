import { SearchField } from "@kompast/ui/Input";
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { Check, CheckSquare, ChevronDown, Layers, MoreHorizontal, Plus } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { Avatar, UnassignedAvatar } from "@kompast/ui/Avatar";
import { IssueTypeIcon } from "@kompast/ui/IssueTypeIcon";
import { PriorityIcon } from "@kompast/ui/PriorityIcon";
import { StatusDot } from "@kompast/ui/Lozenge";
import { Popover } from "@kompast/ui/Popover";
import { MenuItem, MenuLabel, MenuList, MenuSeparator } from "@kompast/ui/Menu";
import { SelectMenu } from "@kompast/ui/SelectMenu";
import { EmptyState, Spinner } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import { normalizeTableViewConfig } from "@kompast/core/table-view-config";
import { updateTableViewFn } from "@/lib/server-fns/projects";
import { moveIssueFn, moveIssuesFn, createIssueFn } from "@/lib/server-fns/issues";
import { updateIssueTitleFn, archiveIssueFn } from "@/lib/server-fns/issue-detail";
import { completeSprintFn, listSprintsFn } from "@/lib/server-fns/sprints";
import { CompleteSprintDialog } from "./BacklogView";
import { StandupDialog } from "./StandupDialog";
import { useConfirmArm } from "@/lib/use-confirm-arm";
import { IssueChecklist, type ChecklistSummary } from "@/components/issues/IssueChecklist";
import { cn } from "@/lib/cn";
import { FadeScroller } from "./FadeScroller";
import { compareAssigneeGroups, daysUntil, formatShortDate, useIntlLocale, useProjectLookups, useSuppressClickAfterDrag, type BoardData, type BoardIssue } from "./project-shared";

/** Sentinel swimlane key for issues with no assignee — never a real assigneeId (nanoids never start with "__"). */
const UNASSIGNED_SWIMLANE = "__unassigned__";
/** Sentinel "add issue" target for flat (non-swimlane) mode, where there's no lane to key off. */
const FLAT_BOARD_TARGET = "__flat__";

function assigneeSwimlaneKey(issue: { assigneeId: string | null }): string {
  return issue.assigneeId ?? UNASSIGNED_SWIMLANE;
}

/** Droppable ids are plain column ids in flat mode, `${columnId}::${swimlaneKey}` in swimlane mode. */
function parseDroppableId(id: string): { columnId: string; swimlaneKey?: string } {
  const sep = id.indexOf("::");
  if (sep === -1) return { columnId: id };
  return { columnId: id.slice(0, sep), swimlaneKey: id.slice(sep + 2) };
}

type Column = BoardData["columns"][number];

interface CardCommon {
  teamId: string;
  projectKey: string;
  columns: Column[];
  issueTypesById: Map<string, BoardData["issueTypes"][number]>;
  usersById: Map<string, BoardData["users"][number]>;
  priorityLevelsByKey: Map<string, BoardData["priorityLevels"][number]>;
  epicsById: Map<string, BoardData["candidateEpics"][number]>;
  visibleProperties: BoardData["propertyDefinitions"];
  canManageProject: boolean;
  onMoveToAdjacentColumn: (issueId: string, fromColumnId: string, direction: "prev" | "next", swimlaneKey?: string) => void;
  onMoveToColumn: (issueId: string, columnId: string) => void;
  registerCardRef: (issueId: string, el: HTMLAnchorElement | null) => void;
  selectedIds: Set<string>;
  onToggleSelected: (issueId: string) => void;
  selectionActive: boolean;
}

interface AddIssueProps {
  addingIssueTarget: string | null;
  newIssueTitle: string;
  onNewIssueTitleChange: (value: string) => void;
  onStartAddIssue: (target: string) => void;
  onSubmitAddIssue: () => void;
  onCancelAddIssue: () => void;
  addIssueError: string | null;
}

export function KanbanBoard({ data }: { data: BoardData }) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const shell = useLoaderData({ from: "/_app" });
  const me = { id: shell.user.id, name: shell.user.name };
  const locale = useIntlLocale();
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set());
  // Your own empty lane is shown so "+ Create issue" there assigns to you, but an
  // assignee filter that leaves you out still hides it.
  const showMyEmptyLane = assigneeFilter.size === 0 || assigneeFilter.has(me.id);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const groupRef = useRef<HTMLButtonElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const suppress = useSuppressClickAfterDrag();
  const usersById = useMemo(() => new Map(data.users.map((u) => [u.id, u])), [data.users]);
  const issueTypesById = useMemo(() => new Map(data.issueTypes.map((tp) => [tp.id, tp])), [data.issueTypes]);
  const priorityLevelsByKey = useMemo(() => new Map(data.priorityLevels.map((p) => [p.key, p])), [data.priorityLevels]);
  const epicsById = useMemo(() => new Map(data.candidateEpics.map((e) => [e.id, e])), [data.candidateEpics]);
  const tableViewConfig = normalizeTableViewConfig(data.tableView.config);
  const teamId = data.project.teamId ?? "none";
  const lookups = useProjectLookups(data.project.id);
  const [futureSprints, setFutureSprints] = useState<Awaited<ReturnType<typeof listSprintsFn>>>([]);
  const [completeOpen, setCompleteOpen] = useState(false);
  // Declared above the no-active-sprint early return so hook order stays stable.
  const [standupOpen, setStandupOpen] = useState(false);

  async function openComplete() {
    try {
      const list = await listSprintsFn({ data: data.board.id });
      setFutureSprints(list.filter((s) => s.state === "future").sort((a, b) => a.number - b.number));
    } catch {
      setFutureSprints([]);
    }
    setCompleteOpen(true);
  }

  async function confirmComplete(carryToSprintId: string | undefined) {
    setCompleteOpen(false);
    if (!data.activeSprint) return;
    setPending(true);
    setError(null);
    try {
      await completeSprintFn({ data: { sprintId: data.activeSprint.id, carryToSprintId } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setPending(false);
    }
  }

  async function updateSwimlaneBy(swimlaneBy: "none" | "assignee") {
    await updateTableViewFn({
      data: { viewId: data.tableView.id, groupBy: tableViewConfig.groupBy, swimlaneBy, sort: tableViewConfig.sort, filters: tableViewConfig.filters },
    });
    await router.invalidate();
  }

  // "+ add issue" at the bottom of a column's first non-backlog cell reuses
  // addIssueToSprint's own Backlog->To Do transition (see
  // packages/core/src/sprint.ts): create with sprintId set and it lands in the
  // right column on its own. In swimlane mode the lane key pre-assigns it,
  // the same way Jira's per-swimlane "+ Create issue" does.
  const defaultType = data.issueTypes.find((tp) => !tp.isSubtask && tp.hierarchyLevel !== 0);
  const [addingIssueTarget, setAddingIssueTarget] = useState<string | null>(null);
  const [newBoardIssueTitle, setNewBoardIssueTitle] = useState("");
  const [addBoardIssueError, setAddBoardIssueError] = useState<string | null>(null);

  async function submitBoardIssue() {
    if (!newBoardIssueTitle.trim() || !defaultType || !data.activeSprint || addingIssueTarget === null) return;
    setPending(true);
    setAddBoardIssueError(null);
    try {
      const assigneeId = addingIssueTarget === FLAT_BOARD_TARGET || addingIssueTarget === UNASSIGNED_SWIMLANE ? undefined : addingIssueTarget;
      await createIssueFn({
        data: { projectId: data.project.id, typeId: defaultType.id, title: newBoardIssueTitle.trim(), assigneeId, sprintId: data.activeSprint.id },
      });
      setNewBoardIssueTitle("");
      await router.invalidate();
    } catch (err) {
      setAddBoardIssueError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setPending(false);
    }
  }

  // A keyboard-moved card unmounts from its old column and remounts under a
  // new one once `data` refreshes — React can't preserve focus across that.
  // Track the moved issue's DOM node by id and refocus it once the new data
  // (and the new Card instance) lands, so a multi-hop move stays keyboard-navigable.
  const cardRefs = useRef(new Map<string, HTMLAnchorElement>());
  const pendingFocusId = useRef<string | null>(null);
  function registerCardRef(issueId: string, el: HTMLAnchorElement | null) {
    if (el) cardRefs.current.set(issueId, el);
    else cardRefs.current.delete(issueId);
  }
  useEffect(() => {
    if (pendingFocusId.current) {
      cardRefs.current.get(pendingFocusId.current)?.focus();
      pendingFocusId.current = null;
    }
  }, [data]);

  const activeSprintIssueIds = new Set(data.activeSprintIssueIds);
  const needle = search.trim().toLowerCase();
  const sprintColumns = data.columns
    .filter((col) => !col.isBacklog)
    .map((col) => ({ ...col, issues: col.issues.filter((i) => activeSprintIssueIds.has(i.id)) }));
  const columns = sprintColumns.map((col) => ({
    ...col,
    issues: col.issues.filter(
      (i) =>
        (!needle || i.title.toLowerCase().includes(needle) || `${data.project.key}-${i.keySeq}`.toLowerCase().includes(needle)) &&
        (assigneeFilter.size === 0 || assigneeFilter.has(assigneeSwimlaneKey(i))),
    ),
  }));
  const allSprintIssues = sprintColumns.flatMap((c) => c.issues);
  const assigneeIdsInUse = [...new Set(allSprintIssues.map((i) => i.assigneeId).filter((x): x is string => !!x))];
  const hasUnassigned = allSprintIssues.some((i) => !i.assigneeId);
  const filtersActive = needle !== "" || assigneeFilter.size > 0;

  // Multi-select: shift/cmd/ctrl-click a card (or tick its checkbox) to build a selection,
  // then drag any selected card or use the action bar to move the whole selection at once.
  // Hooks stay above the early return below.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [moveMenuOpen, setMoveMenuOpen] = useState(false);
  const moveMenuRef = useRef<HTMLButtonElement>(null);
  const hasSelection = selectedIds.size > 0;

  // Drop selections for cards no longer on the board (filtered out, moved, archived).
  // setState only runs when something is actually removed, so this cannot loop.
  useEffect(() => {
    const visible = new Set(columns.flatMap((c) => c.issues.map((i) => i.id)));
    const stale = [...selectedIds].filter((id) => !visible.has(id));
    if (stale.length > 0) setSelectedIds((prev) => new Set([...prev].filter((id) => visible.has(id))));
  }, [columns, selectedIds]);

  useEffect(() => {
    if (!hasSelection) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      setSelectedIds(new Set());
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hasSelection]);

  function toggleSelected(issueId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  /** Selected ids in board order: column order, then card order within each column. */
  function selectedInBoardOrder(): string[] {
    return columns.flatMap((c) => c.issues.map((i) => i.id)).filter((id) => selectedIds.has(id));
  }

  async function runBulkMove(ids: string[], columnId: string) {
    const target = columns.find((c) => c.id === columnId);
    if (!target?.statusIds[0] || ids.length === 0) return;
    const remaining = target.issues.filter((i) => !ids.includes(i.id));
    const position = data.board.newIssuePosition === "bottom" ? "bottom" : "top";
    const edgeIssueId = position === "bottom" ? remaining.at(-1)?.id : remaining.at(0)?.id;
    setPending(true);
    setError(null);
    setAnnouncement(null);
    try {
      await moveIssuesFn({ data: { issueIds: ids, toStatusId: target.statusIds[0], position, edgeIssueId } });
      clearSelection();
      await router.invalidate();
      setAnnouncement(t("boardView.movedCount", { count: ids.length, column: target.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setPending(false);
    }
  }

  async function runMove(input: Parameters<typeof moveIssueFn>[0]["data"], focus = false, announce?: string) {
    setPending(true);
    setError(null);
    setAnnouncement(null);
    try {
      await moveIssueFn({ data: input });
      if (focus) pendingFocusId.current = input.issueId;
      await router.invalidate();
      if (announce) setAnnouncement(announce);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setPending(false);
    }
  }

  function handleDragStart(e: DragStartEvent) {
    suppress.arm();
    setActiveDragId(String(e.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    // Dropping onto a column (or, in swimlane mode, a column×swimlane cell)'s
    // empty area moves to the end of that cell; dropping onto a specific card
    // inserts before it. Both are encoded as droppable ids.
    const overIsCard = columns.some((c) => c.issues.some((i) => i.id === overId));
    let toStatusId: string | undefined;
    let beforeIssueId: string | undefined;
    let afterIssueId: string | undefined;
    // Set only in swimlane mode — stays undefined for a flat-board drag, so
    // moveIssueFn's assigneeId is never sent and a plain column move is unaffected.
    let targetSwimlaneKey: string | undefined;

    if (overIsCard) {
      const targetColumn = columns.find((c) => c.issues.some((i) => i.id === overId))!;
      toStatusId = targetColumn.statusIds[0];
      beforeIssueId = overId;
      const targetIssue = targetColumn.issues.find((i) => i.id === overId);
      if (targetIssue && tableViewConfig.swimlaneBy === "assignee") targetSwimlaneKey = assigneeSwimlaneKey(targetIssue);
    } else {
      const { columnId, swimlaneKey } = parseDroppableId(overId);
      const overColumn = columns.find((c) => c.id === columnId);
      if (!overColumn) return;
      toStatusId = overColumn.statusIds[0];
      targetSwimlaneKey = swimlaneKey;
      // rankBetween(before, after): before = predecessor, after = successor.
      // Landing at the bottom pins the current last card as predecessor;
      // landing at the top pins the current first card as successor.
      const cellIssues = swimlaneKey !== undefined ? overColumn.issues.filter((i) => assigneeSwimlaneKey(i) === swimlaneKey) : overColumn.issues;
      if (data.board.newIssuePosition === "bottom") beforeIssueId = cellIssues.at(-1)?.id;
      else afterIssueId = cellIssues.at(0)?.id;
    }
    if (!toStatusId) return;
    // Dragging one card of a multi-selection moves the whole selection into the target column.
    if (selectedIds.has(activeId) && selectedIds.size > 1) {
      const targetColumn = columns.find((c) => c.statusIds[0] === toStatusId);
      if (targetColumn) await runBulkMove(selectedInBoardOrder(), targetColumn.id);
      return;
    }
    const assigneeId: string | null | undefined =
      targetSwimlaneKey === undefined ? undefined : targetSwimlaneKey === UNASSIGNED_SWIMLANE ? null : targetSwimlaneKey;
    await runMove({ issueId: activeId, toStatusId, beforeIssueId, afterIssueId, assigneeId });
  }

  // Keyboard alternative to pointer DnD: a focused card's Left/Right arrow
  // moves it deterministically to the adjacent column.
  async function moveToAdjacentColumn(issueId: string, fromColumnId: string, direction: "prev" | "next", swimlaneKey?: string) {
    const idx = columns.findIndex((c) => c.id === fromColumnId);
    const target = columns[direction === "prev" ? idx - 1 : idx + 1];
    if (!target?.statusIds[0]) return;
    const targetIssues = swimlaneKey !== undefined ? target.issues.filter((i) => assigneeSwimlaneKey(i) === swimlaneKey) : target.issues;
    const edge = data.board.newIssuePosition === "bottom" ? { beforeIssueId: targetIssues.at(-1)?.id } : { afterIssueId: targetIssues.at(0)?.id };
    await runMove({ issueId, toStatusId: target.statusIds[0], ...edge }, true, t("boardView.movedToColumn", { column: target.name }));
  }

  async function moveToColumn(issueId: string, columnId: string) {
    const target = columns.find((c) => c.id === columnId);
    if (!target?.statusIds[0]) return;
    const edge = data.board.newIssuePosition === "bottom" ? { beforeIssueId: target.issues.at(-1)?.id } : { afterIssueId: target.issues.at(0)?.id };
    await runMove({ issueId, toStatusId: target.statusIds[0], ...edge }, false, t("boardView.movedToColumn", { column: target.name }));
  }

  if (!data.activeSprint) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Layers size={18} />}
          title={t("boardView.noActiveTitle")}
          description={t("sprint.boardEmptySubtext")}
          action={
            <Link to="/projects/$teamId/$projectKey" params={{ teamId, projectKey: data.project.key }} search={{ tab: "backlog" }}>
              <Button variant="primary">{t("boardView.goToBacklog")}</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const sprint = data.activeSprint;
  const days = sprint.endAt ? daysUntil(sprint.endAt) : null;
  const cardCommon: CardCommon = {
    teamId,
    projectKey: data.project.key,
    columns,
    issueTypesById,
    usersById,
    priorityLevelsByKey,
    epicsById,
    visibleProperties: data.propertyDefinitions.filter((p) => p.visibleOnCard),
    canManageProject: data.canManageProject,
    onMoveToAdjacentColumn: moveToAdjacentColumn,
    onMoveToColumn: moveToColumn,
    registerCardRef,
    selectedIds,
    onToggleSelected: toggleSelected,
    selectionActive: hasSelection,
  };
  const addProps: AddIssueProps = {
    addingIssueTarget,
    newIssueTitle: newBoardIssueTitle,
    onNewIssueTitleChange: setNewBoardIssueTitle,
    onStartAddIssue: setAddingIssueTarget,
    onSubmitAddIssue: submitBoardIssue,
    onCancelAddIssue: () => {
      setAddingIssueTarget(null);
      setAddBoardIssueError(null);
      setNewBoardIssueTitle("");
    },
    addIssueError: addBoardIssueError,
  };
  const activeIssue = activeDragId ? allSprintIssues.find((i) => i.id === activeDragId) : undefined;

  function toggleAssignee(key: string) {
    setAssigneeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveDragId(null)}>
      <div className="kp-board relative flex h-full min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
          <div className="mr-2 flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[15px] font-semibold">{sprint.name}</span>
            <span className="type-small text-text-3">
              {formatShortDate(sprint.startAt, locale) ?? "?"} – {formatShortDate(sprint.endAt, locale) ?? "?"}
              {days !== null && (
                <span className={cn("ml-1.5", days < 0 ? "text-danger" : days <= 2 ? "text-amber" : "")}>
                  · {days < 0 ? t("backlog.ended", { date: formatShortDate(sprint.endAt, locale) }) : t("backlog.daysLeft", { count: days })}
                </span>
              )}
            </span>
          </div>
          <SearchField
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClear={() => setSearch("")}
            placeholder={t("boardView.searchPlaceholder")}
            aria-label={t("boardView.searchPlaceholder")}
            wrapperClassName="w-full sm:w-[210px]"
          />
          {(assigneeIdsInUse.length > 0 || hasUnassigned) && (
            <div className="flex items-center pl-1" role="group" aria-label={t("backlog.quickFilters")}>
              {assigneeIdsInUse.map((id) => {
                const name = usersById.get(id)?.name ?? "?";
                const on = assigneeFilter.has(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggleAssignee(id)}
                    aria-pressed={on}
                    title={name}
                    className={cn("-ml-1 rounded-full ring-2 transition-transform first:ml-0 hover:z-10 hover:-translate-y-0.5", on ? "z-10 ring-accent" : "ring-bg")}
                  >
                    <Avatar name={name} size={28} />
                  </button>
                );
              })}
              {hasUnassigned && (
                <button
                  type="button"
                  onClick={() => toggleAssignee(UNASSIGNED_SWIMLANE)}
                  aria-pressed={assigneeFilter.has(UNASSIGNED_SWIMLANE)}
                  title={t("backlog.unassigned")}
                  className={cn("-ml-1 rounded-full ring-2 hover:z-10", assigneeFilter.has(UNASSIGNED_SWIMLANE) ? "z-10 ring-accent" : "ring-bg")}
                >
                  <UnassignedAvatar size={28} />
                </button>
              )}
            </div>
          )}
          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setAssigneeFilter(new Set()); }}>
              {t("boardView.clearFilters")}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="type-small" aria-live="polite">
              {pending && (
                <span className="flex items-center gap-1.5 text-text-3">
                  <Spinner size={12} /> {t("savingEllipsis")}
                </span>
              )}
              {!pending && error && <span className="text-danger">{error}</span>}
              {!pending && !error && announcement && <span className="text-text-3">{announcement}</span>}
            </span>
            <Button ref={groupRef} variant="ghost" size="sm" onClick={() => setGroupOpen(!groupOpen)}>
              {t("boardView.groupBy")}: <span className="font-semibold text-text">{tableViewConfig.swimlaneBy === "assignee" ? t("boardView.groupAssignee") : t("boardView.groupNone")}</span>
              <ChevronDown size={14} />
            </Button>
            <SelectMenu
              open={groupOpen}
              onClose={() => setGroupOpen(false)}
              anchorRef={groupRef}
              placement="bottom-end"
              width={180}
              options={[
                { value: "none", label: t("boardView.groupNone") },
                { value: "assignee", label: t("boardView.groupAssignee") },
              ]}
              value={tableViewConfig.swimlaneBy}
              onSelect={(v) => updateSwimlaneBy(v as "none" | "assignee")}
            />
            <Button variant="outline" size="sm" onClick={() => setStandupOpen(true)} disabled={pending}>
              {t("standup.button")}
            </Button>
            <Button variant="outline" size="sm" onClick={openComplete} disabled={pending}>
              {t("boardView.completeSprint")}
            </Button>
          </div>
        </div>

        <p id="kanban-keyboard-hint" className="sr-only">
          {t("boardView.keyboardHint")}
        </p>

        {/* `relative` makes this scroller the containing block for absolutely positioned
            card bits (PriorityIcon's sr-only label). Without it they resolve to .kp-board,
            escape this overflow clip, and stretch the page with a big empty gap below. */}
        <div className="relative min-h-0 flex-1 overflow-auto px-4 pb-4 sm:px-6">
          {tableViewConfig.swimlaneBy === "assignee" ? (
            <SwimlaneBoard
              columns={columns}
              usersById={usersById}
              cardCommon={cardCommon}
              addProps={addProps}
              me={me}
              showMyEmptyLane={showMyEmptyLane}
              maxCardsPerLane={data.board.swimlaneMaxCards}
            />
          ) : (
            <div className="flex h-full min-w-fit items-stretch gap-3">
              {columns.map((col, index) => (
                <div key={col.id} className="flex h-full min-h-0 w-[280px] flex-none flex-col rounded-[10px] bg-surface-2">
                  <ColumnHeader column={col} />
                  <FadeScroller className="flex-1" scrollClassName="px-2 pb-2">
                    <ColumnCell
                      droppableId={col.id}
                      issues={col.issues}
                      columnId={col.id}
                      cardCommon={cardCommon}
                      addProps={index === 0 ? addProps : undefined}
                      addTarget={FLAT_BOARD_TARGET}
                      // Grows to fill the column so the whole column stays a drop target.
                      className="flex-1"
                    />
                  </FadeScroller>
                </div>
              ))}
            </div>
          )}
        </div>
        {selectedIds.size > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <div
              role="toolbar"
              aria-label={t("boardView.bulkActions")}
              className="pointer-events-auto flex items-center gap-2 rounded-[10px] bg-surface px-3 py-2 shadow-lift"
            >
              <span className="type-small font-semibold text-text">{t("boardView.selectedCount", { count: selectedIds.size })}</span>
              <Button ref={moveMenuRef} variant="outline" size="sm" onClick={() => setMoveMenuOpen((v) => !v)} disabled={pending}>
                {t("boardView.moveSelectedTo")}
                <ChevronDown size={14} />
              </Button>
              <SelectMenu
                open={moveMenuOpen}
                onClose={() => setMoveMenuOpen(false)}
                anchorRef={moveMenuRef}
                placement="top-start"
                width={200}
                options={columns.map((c) => ({ value: c.id, label: c.name }))}
                value={null}
                onSelect={(columnId) => {
                  setMoveMenuOpen(false);
                  runBulkMove(selectedInBoardOrder(), columnId);
                }}
              />
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                {t("boardView.clearSelection")}
              </Button>
            </div>
          </div>
        )}
      </div>
      {standupOpen && (
        <StandupDialog
          data={data}
          sprintId={sprint.id}
          teamId={teamId}
          statusesById={lookups.statusesById}
          onClose={() => setStandupOpen(false)}
        />
      )}
      <CompleteSprintDialog
        sprint={completeOpen ? sprint : null}
        rows={allSprintIssues}
        futureSprints={futureSprints}
        statusesById={lookups.statusesById}
        onClose={() => setCompleteOpen(false)}
        onConfirm={confirmComplete}
      />
      <DragOverlay dropAnimation={null}>
        {activeIssue ? (
          <div className="relative w-[264px] rotate-[1.5deg] cursor-grabbing">
            <CardBody issue={activeIssue} {...cardCommon} lifted />
            {selectedIds.has(activeIssue.id) && selectedIds.size > 1 && (
              <span className="absolute -right-2 -top-2 rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">
                +{selectedIds.size - 1}
              </span>
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ColumnHeader({ column, compact }: { column: Column; compact?: boolean }) {
  const { t } = useTranslation("board");
  const over = column.wipLimit != null && column.issues.length > column.wipLimit;
  return (
    <div
      className={cn(
        "sticky top-0 z-[1] flex h-10 items-center gap-2 rounded-t-[10px] px-3",
        compact ? "bg-transparent px-1" : "bg-surface-2",
        over && !compact && "bg-danger-soft",
      )}
      title={over ? t("boardView.wipExceeded", { count: column.issues.length, limit: column.wipLimit }) : undefined}
    >
      <StatusDot color={column.color} />
      <span className="truncate type-label-overline text-text-2">{column.name}</span>
      <span className={cn("text-[12px] font-semibold tabular-nums", over ? "text-danger" : "text-text-3")}>
        {column.issues.length}
        {column.wipLimit != null && <span className="font-normal"> / {column.wipLimit}</span>}
      </span>
    </div>
  );
}

function ColumnCell({
  droppableId,
  issues,
  columnId,
  swimlaneKey,
  cardCommon,
  addProps,
  addTarget,
  className,
}: {
  droppableId: string;
  issues: BoardIssue[];
  columnId: string;
  swimlaneKey?: string;
  cardCommon: CardCommon;
  addProps?: AddIssueProps;
  addTarget: string;
  className?: string;
}) {
  const { t } = useTranslation("board");
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });
  const adding = addProps?.addingIssueTarget === addTarget;
  const addFormRef = useRef<HTMLDivElement>(null);
  // The cell scrolls on its own, so an add form opened near the bottom can sit off-screen.
  useEffect(() => {
    if (adding) addFormRef.current?.scrollIntoView({ block: "nearest" });
  }, [adding]);

  return (
    <div
      ref={setNodeRef}
      className={cn("flex flex-col gap-1.5 rounded-[8px] transition-colors", isOver && "bg-accent-soft/60 outline-2 outline-dashed outline-accent/50", className)}
    >
      {issues.map((issue) => (
        <Card key={issue.id} issue={issue} columnId={columnId} swimlaneKey={swimlaneKey} {...cardCommon} />
      ))}
      {addProps &&
        (adding ? (
          <div ref={addFormRef} className="flex flex-col gap-1.5 rounded-[8px] bg-surface p-2 shadow-card">
            <textarea
              autoFocus
              rows={2}
              value={addProps.newIssueTitle}
              onChange={(e) => addProps.onNewIssueTitleChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  addProps.onSubmitAddIssue();
                }
                if (e.key === "Escape") addProps.onCancelAddIssue();
              }}
              placeholder={t("backlog.createIssuePlaceholder")}
              className="w-full resize-none bg-transparent text-[14px] leading-snug outline-none"
            />
            {addProps.addIssueError && <p className="type-small text-danger">{addProps.addIssueError}</p>}
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" size="xs" onClick={addProps.onCancelAddIssue}>
                {t("cancel")}
              </Button>
              <Button variant="primary" size="xs" onClick={addProps.onSubmitAddIssue} disabled={!addProps.newIssueTitle.trim()}>
                {t("boardView.addIssueButton")}
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => addProps.onStartAddIssue(addTarget)}
            className="flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-left text-[13.5px] text-text-2 hover:bg-surface-4 hover:text-text"
          >
            <Plus size={15} /> {t("boardView.addIssueButton")}
          </button>
        ))}
      {issues.length === 0 && !addProps && <div className="min-h-[52px]" aria-hidden />}
    </div>
  );
}

/**
 * Jira-style swimlanes: status columns stay as-is, one row per assignee
 * (your lane first, then A→Z, Unassigned last; your lane shows even when empty).
 * Dragging a card between lanes reassigns it to match
 * the lane it's dropped into; dropping into Unassigned clears the assignee.
 */
function SwimlaneBoard({
  columns,
  usersById,
  cardCommon,
  addProps,
  me,
  showMyEmptyLane,
  maxCardsPerLane,
}: {
  columns: Column[];
  usersById: Map<string, BoardData["users"][number]>;
  cardCommon: CardCommon;
  addProps: AddIssueProps;
  me: { id: string; name: string };
  showMyEmptyLane: boolean;
  maxCardsPerLane: number;
}) {
  const { t } = useTranslation("board");
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set());
  const byKey = new Map<string, { key: string; label: string }>();
  for (const col of columns) {
    for (const issue of col.issues) {
      const key = assigneeSwimlaneKey(issue);
      if (!byKey.has(key)) {
        byKey.set(key, { key, label: issue.assigneeId ? usersById.get(issue.assigneeId)?.name ?? issue.assigneeId : t("tableView.unassignedGroupLabel") });
      }
    }
  }
  // usersById only covers assignees already on the board, so an empty own lane
  // falls back to the signed-in user's name from the loader.
  if (showMyEmptyLane && !byKey.has(me.id)) byKey.set(me.id, { key: me.id, label: me.name });
  const assignedLanes = [...byKey.values()]
    .filter((l) => l.key !== UNASSIGNED_SWIMLANE)
    .sort((a, b) => compareAssigneeGroups(a, b, me.id, UNASSIGNED_SWIMLANE));
  // Always shown, even empty: "+ Create issue" in the Unassigned lane is where unassigned work lands.
  const unassignedLane = byKey.get(UNASSIGNED_SWIMLANE) ?? { key: UNASSIGNED_SWIMLANE, label: t("tableView.unassignedGroupLabel") };
  const swimlanes = [...assignedLanes, unassignedLane];

  return (
    <div className="flex min-w-fit flex-col gap-2">
      {/* Pinned while lanes scroll beneath; bg-bg keeps cards from showing through the gaps. */}
      <div className="sticky top-0 z-[2] flex gap-3 bg-bg">
        {columns.map((col) => (
          <div key={col.id} className="w-[280px] flex-none rounded-[10px] bg-surface-2">
            <ColumnHeader column={col} />
          </div>
        ))}
      </div>
      {swimlanes.map((lane) => {
        const count = columns.reduce((sum, col) => sum + col.issues.filter((i) => assigneeSwimlaneKey(i) === lane.key).length, 0);
        const isCollapsed = collapsedLanes.has(lane.key);
        return (
          <div key={lane.key} className="flex flex-col gap-1.5">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() =>
                setCollapsedLanes((prev) => {
                  const next = new Set(prev);
                  if (next.has(lane.key)) next.delete(lane.key);
                  else next.add(lane.key);
                  return next;
                })
              }
              className="flex h-8 w-fit items-center gap-2 rounded-[6px] px-1.5 hover:bg-surface-3"
            >
              <ChevronDown size={14} className={cn("text-text-3 transition-transform", isCollapsed && "-rotate-90")} />
              {lane.key !== UNASSIGNED_SWIMLANE ? <Avatar name={lane.label} size={20} /> : <UnassignedAvatar size={20} />}
              <span className="text-[13.5px] font-medium">{lane.label}</span>
              <span className="type-small text-text-3">{t("backlog.issueCount", { count })}</span>
            </button>
            {!isCollapsed && (
              <LaneCells
                maxCards={maxCardsPerLane}
                fullestCell={Math.max(0, ...columns.map((col) => col.issues.filter((i) => assigneeSwimlaneKey(i) === lane.key).length))}
                label={lane.label}
              >
                {columns.map((col, index) => (
                  <div key={col.id} data-lane-cell className="flex w-[280px] flex-none flex-col rounded-[10px] bg-surface-2">
                    <FadeScroller className="flex-1" scrollClassName="p-2">
                      <ColumnCell
                        droppableId={`${col.id}::${lane.key}`}
                        issues={col.issues.filter((i) => assigneeSwimlaneKey(i) === lane.key)}
                        columnId={col.id}
                        swimlaneKey={lane.key}
                        cardCommon={cardCommon}
                        addProps={index === 0 ? addProps : undefined}
                        addTarget={lane.key}
                        // An empty cell (your own empty lane, an empty Unassigned) would otherwise
                        // collapse to its padding and be hard to drop a card into; flex-1 fills the lane height.
                        className="min-h-[56px] flex-1"
                      />
                    </FadeScroller>
                  </div>
                ))}
              </LaneCells>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * One swimlane's row of cells. Once its fullest cell holds more than `maxCards`
 * cards, the lane gets a fixed height of exactly `maxCards` cards (measured,
 * since card heights vary) and each cell scrolls on its own — the same
 * per-column scrolling as the ungrouped board, scoped to one assignee — so a
 * heavily loaded assignee doesn't push every other lane far down the page.
 */
function LaneCells({ maxCards, fullestCell, label, children }: { maxCards: number; fullestCell: number; label: string; children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const capped = fullestCell > maxCards;

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !capped) {
      setMaxHeight(null);
      return;
    }
    const scrollers = () => row.querySelectorAll<HTMLElement>(":scope > [data-lane-cell] [data-fade-scroller]");
    const measure = () => {
      let height = 0;
      for (const scroller of scrollers()) {
        // The Nth card's bottom edge, in the cell scroller's content coordinates, is where the cap goes.
        const nth = scroller.querySelectorAll("[data-board-card]")[maxCards - 1];
        if (nth) height = Math.max(height, nth.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop);
      }
      // + the scroller's bottom padding (p-2), so the last visible card isn't flush against the edge.
      if (height > 0) setMaxHeight(Math.ceil(height + 8));
    };
    measure();
    // Card heights change with edits, fonts loading and title wrapping; re-measure when a cell's content resizes.
    const observer = new ResizeObserver(measure);
    for (const scroller of scrollers()) for (const content of scroller.children) observer.observe(content);
    return () => observer.disconnect();
  });

  return (
    <div
      ref={rowRef}
      role={capped ? "region" : undefined}
      aria-label={capped ? label : undefined}
      // Capped: the row holds the lane height; each cell stretches to it and its FadeScroller scrolls on its own.
      className="flex gap-3"
      style={capped && maxHeight !== null ? { maxHeight } : undefined}
    >
      {children}
    </div>
  );
}

function formatPropertyValue(type: string, value: unknown, intlLocale: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (type === "checkbox") return value ? "✓" : null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : null;
  if (type === "date") {
    const d = new Date(value as string);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString(intlLocale, { day: "numeric", month: "short" });
  }
  return String(value);
}

const ChecklistBadge = forwardRef<HTMLButtonElement, { summary: ChecklistSummary; onClick?: (e: React.MouseEvent) => void }>(function ChecklistBadge(
  { summary, onClick },
  ref,
) {
  const { t } = useTranslation("issue");
  const complete = summary.done === summary.total;
  return (
    <button
      ref={ref}
      type="button"
      tabIndex={onClick ? 0 : -1}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      title={t("checklist.cardBadge", { done: summary.done, total: summary.total })}
      aria-label={t("checklist.cardBadge", { done: summary.done, total: summary.total })}
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-[4px] px-1 text-[11.5px] font-medium tabular-nums outline-none hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent",
        complete ? "bg-green-soft text-green" : "text-text-3",
      )}
    >
      <CheckSquare size={13} strokeWidth={2} />
      {summary.done}/{summary.total}
    </button>
  );
});

/** The card's visual content — shared by the real card and the drag overlay. */
function CardBody({
  issue,
  projectKey,
  issueTypesById,
  usersById,
  priorityLevelsByKey,
  epicsById,
  visibleProperties,
  lifted,
  title,
  menu,
  checklist,
  selectControl,
}: Pick<CardCommon, "projectKey" | "issueTypesById" | "usersById" | "priorityLevelsByKey" | "epicsById" | "visibleProperties"> & {
  issue: BoardIssue;
  lifted?: boolean;
  title?: React.ReactNode;
  menu?: React.ReactNode;
  /** Interactive checklist badge (real card); the drag overlay falls back to a static one. */
  checklist?: React.ReactNode;
  /** Selection checkbox (real card only; the drag overlay shows none). */
  selectControl?: React.ReactNode;
}) {
  const locale = useIntlLocale();
  const type = issueTypesById.get(issue.typeId);
  const assignee = issue.assigneeId ? usersById.get(issue.assigneeId) : undefined;
  const epic = issue.epicId ? epicsById.get(issue.epicId) : undefined;
  const priority = priorityLevelsByKey.get(issue.priority) ?? { key: issue.priority, name: issue.priority };
  const customFields = (issue.customFields ?? {}) as Record<string, unknown>;
  const chips = visibleProperties
    .map((p) => ({ def: p, text: formatPropertyValue(p.type, customFields[p.key], locale) }))
    .filter((c): c is { def: (typeof visibleProperties)[number]; text: string } => c.text !== null);
  const due = issue.dueDate ? new Date(issue.dueDate) : null;
  const overdue = due ? due.getTime() < Date.now() : false;

  return (
    <div className={cn("group/card rounded-[8px] bg-surface p-3 shadow-card transition-shadow", lifted ? "shadow-lift" : "hover:shadow-lift")}>
      <div className="flex items-start gap-2">
        {selectControl}
        <div className="min-w-0 flex-1">{title ?? <p className="line-clamp-2 text-[14px] leading-snug text-text">{issue.title}</p>}</div>
        {menu}
      </div>
      {(epic || issue.labels.length > 0 || chips.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {epic && <span className="max-w-full truncate rounded-[4px] bg-violet-soft px-1.5 py-0.5 text-[11.5px] font-medium text-violet">{epic.title}</span>}
          {issue.labels.slice(0, 3).map((label) => (
            <span key={label} className="rounded-[4px] bg-surface-3 px-1.5 py-0.5 text-[11.5px] font-medium text-text-2">
              {label}
            </span>
          ))}
          {issue.labels.length > 3 && <span className="rounded-[4px] bg-surface-3 px-1.5 py-0.5 text-[11.5px] text-text-3">+{issue.labels.length - 3}</span>}
          {chips.slice(0, 3).map(({ def, text }) => (
            <span key={def.id} title={def.name} className="max-w-full truncate rounded-[4px] bg-indigo-soft px-1.5 py-0.5 text-[11.5px] font-medium text-indigo">
              {def.name}: {text}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex items-center gap-1.5">
        <IssueTypeIcon type={type} size={16} />
        <span className="type-key text-text-3">
          {projectKey}-{issue.keySeq}
        </span>
        {due && (
          <span className={cn("rounded-[4px] px-1 text-[11.5px]", overdue ? "bg-danger-soft text-danger" : "text-text-3")}>
            {due.toLocaleDateString(locale, { day: "numeric", month: "short" })}
          </span>
        )}
        {checklist ?? (issue.checklist && <ChecklistBadge summary={issue.checklist} />)}
        <span className="ml-auto flex items-center gap-1.5">
          {issue.storyPoints != null && (
            <span className="inline-flex h-5 min-w-[22px] items-center justify-center rounded-full bg-surface-4 px-1.5 text-[11.5px] font-semibold tabular-nums text-text-2">
              {issue.storyPoints}
            </span>
          )}
          <PriorityIcon priority={priority} />
          {assignee ? <Avatar name={assignee.name} size={24} /> : <UnassignedAvatar size={24} />}
        </span>
      </div>
    </div>
  );
}

function Card({ issue, columnId, swimlaneKey, ...common }: CardCommon & { issue: BoardIssue; columnId: string; swimlaneKey?: string }) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const { listeners, attributes, setNodeRef, isDragging } = useDraggable({ id: issue.id });
  const selected = common.selectedIds.has(issue.id);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(issue.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const { isArmed, arm, disarm } = useConfirmArm();
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [checklist, setChecklist] = useState<ChecklistSummary | null>(issue.checklist);
  const checklistChanged = useRef(false);
  const checklistRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setChecklist(issue.checklist), [issue.checklist?.done, issue.checklist?.total]);

  function setRefs(el: HTMLAnchorElement | null) {
    setNodeRef(el);
    common.registerCardRef(issue.id, el);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLAnchorElement>) {
    // Keystrokes typed in the (portalled) checklist popover still bubble here through the React tree.
    if (editingTitle || checklistOpen) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      common.onMoveToAdjacentColumn(issue.id, columnId, "prev", swimlaneKey);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      common.onMoveToAdjacentColumn(issue.id, columnId, "next", swimlaneKey);
    }
  }

  async function saveRename() {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (!trimmed || trimmed === issue.title) return;
    await updateIssueTitleFn({ data: { issueId: issue.id, title: trimmed } });
    await router.invalidate();
  }

  async function handleArchive() {
    if (!isArmed(issue.id)) {
      arm(issue.id);
      return;
    }
    disarm();
    setMenuOpen(false);
    await archiveIssueFn({ data: { issueId: issue.id } });
    await router.invalidate();
  }

  const menu = (
    <>
      <IconButton
        ref={menuRef}
        size="xs"
        aria-label={t("card.archiveMenuLabel")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className="-mr-1 -mt-0.5 opacity-0 focus-visible:opacity-100 group-hover/card:opacity-100 data-[open]:opacity-100"
        data-open={menuOpen || undefined}
      >
        <MoreHorizontal size={15} />
      </IconButton>
      <Popover open={menuOpen} onClose={() => { setMenuOpen(false); disarm(); }} anchorRef={menuRef} placement="bottom-end" role="menu">
        <MenuList>
          <MenuItem
            onClick={() => {
              setMenuOpen(false);
              router.navigate({ to: "/issues/$teamId/$projectKey/$issueKeySeq", params: { teamId: common.teamId, projectKey: common.projectKey, issueKeySeq: String(issue.keySeq) }, search: { from: "board" } });
            }}
          >
            {t("card.openIssue")}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenuOpen(false);
              setTitleDraft(issue.title);
              setEditingTitle(true);
            }}
          >
            {t("card.rename")}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenuOpen(false);
              setChecklistOpen(true);
            }}
          >
            {t("card.checklist")}
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>{t("card.moveToColumn")}</MenuLabel>
          {common.columns
            .filter((c) => c.id !== columnId)
            .map((c) => (
              <MenuItem key={c.id} icon={<StatusDot color={c.color} />} onClick={() => { setMenuOpen(false); common.onMoveToColumn(issue.id, c.id); }}>
                {c.name}
              </MenuItem>
            ))}
          {common.canManageProject && (
            <>
              <MenuSeparator />
              <MenuItem danger onClick={handleArchive} className={cn(isArmed(issue.id) && "bg-danger-soft")}>
                {isArmed(issue.id) ? t("card.clickAgainToArchive") : t("card.archive")}
              </MenuItem>
            </>
          )}
        </MenuList>
      </Popover>
    </>
  );

  function closeChecklist() {
    setChecklistOpen(false);
    if (checklistChanged.current) {
      checklistChanged.current = false;
      router.invalidate();
    }
  }

  const checklistBadge = (
    <>
      {checklist && (
        <ChecklistBadge
          ref={checklistRef}
          summary={checklist}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (checklistOpen) closeChecklist();
            else setChecklistOpen(true);
          }}
        />
      )}
      <Popover
        open={checklistOpen}
        onClose={closeChecklist}
        anchorRef={checklist ? checklistRef : menuRef}
        placement="bottom-start"
        width={320}
        ariaLabel={t("card.checklist")}
        className="p-2.5"
      >
        <IssueChecklist
          issueId={issue.id}
          compact
          autoFocusAdd={!checklist}
          onChange={(summary) => {
            checklistChanged.current = true;
            setChecklist(summary);
          }}
        />
      </Popover>
    </>
  );

  const title = editingTitle ? (
    <textarea
      autoFocus
      rows={2}
      value={titleDraft}
      onChange={(e) => setTitleDraft(e.target.value)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={saveRename}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          saveRename();
        }
        if (e.key === "Escape") {
          setTitleDraft(issue.title);
          setEditingTitle(false);
        }
      }}
      className="w-full resize-none rounded-[4px] border border-accent bg-surface px-1.5 py-1 text-[14px] leading-snug outline-none"
    />
  ) : undefined;

  const selectControl = (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={t("boardView.selectCard")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        common.onToggleSelected(issue.id);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-[4px] border transition-opacity",
        selected ? "border-accent bg-accent text-white" : "border-border2 bg-surface",
        selected || common.selectionActive ? "opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover/card:opacity-100",
      )}
    >
      {selected && <Check size={12} strokeWidth={3} />}
    </button>
  );

  return (
    <Link
      to="/issues/$teamId/$projectKey/$issueKeySeq"
      params={{ teamId: common.teamId, projectKey: common.projectKey, issueKeySeq: String(issue.keySeq) }}
      search={{ from: "board" }}
      ref={setRefs}
      data-board-card
      {...listeners}
      {...attributes}
      role="link"
      onClick={(e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          common.onToggleSelected(issue.id);
        }
      }}
      onKeyDown={handleKeyDown}
      aria-describedby="kanban-keyboard-hint"
      aria-keyshortcuts="ArrowLeft ArrowRight"
      className={cn(
        "block rounded-[8px] outline-none focus-visible:ring-2 focus-visible:ring-accent",
        isDragging && "opacity-30",
        selected && "ring-2 ring-accent",
      )}
    >
      <CardBody issue={issue} {...common} title={title} menu={menu} checklist={checklistBadge} selectControl={selectControl} />
    </Link>
  );
}

