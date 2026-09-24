import { Fragment, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter, Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, Layers, Pencil, Plus, X } from "lucide-react";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { Avatar, UnassignedAvatar } from "@kompast/ui/Avatar";
import { CountPill } from "@kompast/ui/Badge";
import { Lozenge, StatusDot } from "@kompast/ui/Lozenge";
import { IssueTypeIcon } from "@kompast/ui/IssueTypeIcon";
import { PriorityIcon } from "@kompast/ui/PriorityIcon";
import { SelectMenu, type SelectOption } from "@kompast/ui/SelectMenu";
import { useToast } from "@kompast/ui/Toast";
import { normalizeTableViewConfig, type SortField, type SortRule } from "@kompast/core/table-view-config";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { getProjectBoardFn, updateTableViewFn } from "@/lib/server-fns/projects";
import { reorderSprintIssueFn } from "@/lib/server-fns/sprints";
import { moveIssueFn } from "@/lib/server-fns/issues";
import {
  updateIssueAssigneeFn,
  updateIssueDatesFn,
  updateIssuePriorityFn,
  updateIssueStoryPointsFn,
  updateIssueTitleFn,
  updateIssueTypeFn,
} from "@/lib/server-fns/issue-detail";
import { priorityOrderByKey, sortIssues, applyFilters, computeReorderTargets } from "@/lib/table-view-utils";
import { useWorkbench } from "@/components/shell/WorkbenchContext";
import { cn } from "@/lib/cn";
import { FilterBuilder } from "./FilterBuilder";

type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;
type BaseIssue = BoardData["columns"][number]["issues"][number];
type FlatIssue = BaseIssue & { columnId: string; columnName: string; columnColor: string; sprintRank?: string | null };
type Patch = Partial<Pick<FlatIssue, "title" | "typeId" | "statusId" | "columnId" | "columnName" | "columnColor" | "assigneeId" | "priority" | "storyPoints" | "dueDate">>;

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };
const SORT_FIELDS: SortField[] = ["manual", "priority", "dueDate", "points", "key"];
const SORT_FIELD_LABEL_KEY: Record<SortField, string> = {
  manual: "tableView.sortByManual",
  priority: "tableView.sortByPriority",
  dueDate: "tableView.sortByDueDate",
  points: "tableView.sortByPoints",
  key: "tableView.sortByKey",
};

/** Date-only value as YYYY-MM-DD in local time (what <input type="date"> reads/writes). */
function toDateInput(value: string | Date | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const cellButton =
  "flex h-8 min-w-0 items-center gap-2 rounded-[5px] px-2 text-left outline-none transition-colors hover:bg-surface-3 focus-visible:bg-surface-3 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:hover:bg-transparent";

/** A cell whose value is picked from a list (status, assignee, priority, type). */
function PickerCell({
  display,
  options,
  value,
  onSelect,
  label,
  width = 240,
  className,
}: {
  display: ReactNode;
  options: SelectOption[];
  value: string;
  onSelect: (v: string) => void;
  label: string;
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(cellButton, className ?? "w-full")}
      >
        {display}
      </button>
      <SelectMenu open={open} onClose={() => setOpen(false)} anchorRef={ref} width={width} options={options} value={value} onSelect={onSelect} />
    </>
  );
}

/** Click-to-edit text/number/date cell. Enter or blur saves, Escape cancels. */
function InlineInputCell({
  display,
  initial,
  type,
  label,
  onSave,
  align = "left",
}: {
  display: ReactNode;
  initial: string;
  type: "text" | "number" | "date";
  label: string;
  onSave: (value: string) => void;
  align?: "left" | "right";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const cancelled = useRef(false);

  function commit() {
    setEditing(false);
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft !== initial) onSave(draft);
  }

  if (editing) {
    return (
      <input
        autoFocus
        type={type}
        aria-label={label}
        value={draft}
        min={type === "number" ? 0 : undefined}
        step={type === "number" ? "0.5" : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
        className={cn("kp-field h-8 w-full tabular-nums", align === "right" && "text-right")}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        setDraft(initial);
        setEditing(true);
      }}
      className={cn(cellButton, "w-full tabular-nums", align === "right" && "justify-end")}
    >
      {display}
    </button>
  );
}

function TableRow({
  issue,
  data,
  usersById,
  memberOptions,
  showDragHandle,
  dragEnabled,
  intlLocale,
}: {
  issue: FlatIssue;
  data: BoardData;
  usersById: Map<string, { name: string }>;
  memberOptions: SelectOption[];
  showDragHandle: boolean;
  dragEnabled: boolean;
  intlLocale: string;
}) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState<Patch>({});
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(issue.title);
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({ id: issue.id, disabled: !dragEnabled });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: issue.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.5 : 1 } : undefined;

  const view: FlatIssue = { ...issue, ...pending };
  const type = data.issueTypes.find((tp) => tp.id === view.typeId);
  const priority = data.priorityLevels.find((p) => p.key === view.priority);
  const assignee = view.assigneeId ? usersById.get(view.assigneeId) : undefined;
  const teamId = data.project.teamId ?? "none";
  const issueKey = `${data.project.key}-${issue.keySeq}`;

  async function save(patch: Patch, run: () => Promise<unknown>) {
    setPending((p) => ({ ...p, ...patch }));
    try {
      await run();
      await router.invalidate();
    } catch (err) {
      toast.show({ tone: "error", title: t("tableEdit.saveFailed", { key: issueKey }), description: err instanceof Error ? err.message : undefined });
    } finally {
      setPending((p) => {
        const next = { ...p };
        for (const k of Object.keys(patch)) delete next[k as keyof Patch];
        return next;
      });
    }
  }

  const statusOptions: SelectOption[] = data.columns.map((c) => ({ value: c.id, label: c.name, icon: <StatusDot color={c.color} /> }));
  const priorityOptions: SelectOption[] = [...data.priorityLevels]
    .sort((a, b) => b.order - a.order)
    .map((p) => ({ value: p.key, label: p.name, icon: <PriorityIcon priority={p} /> }));
  const typeOptions: SelectOption[] = data.issueTypes
    .filter((tp) => tp.hierarchyLevel === type?.hierarchyLevel)
    .map((tp) => ({ value: tp.id, label: tp.name, icon: <IssueTypeIcon type={tp} size={16} /> }));

  function saveTitle() {
    const next = titleDraft.trim();
    setRenaming(false);
    if (!next || next === issue.title) return;
    save({ title: next }, () => updateIssueTitleFn({ data: { issueId: issue.id, title: next } }));
  }

  return (
    <tr
      ref={setDropRef}
      style={style}
      className={cn("group/row kp-table-row border-b border-border bg-surface transition-colors hover:bg-surface-2", isOver && dragEnabled && "bg-accent-soft")}
    >
      {showDragHandle && (
        <td className="w-7 pl-1.5">
          {dragEnabled ? (
            <span
              ref={setDragRef}
              {...listeners}
              {...attributes}
              aria-label={t("tableEdit.dragHandle")}
              className="grid h-7 w-5 cursor-grab place-items-center rounded text-text-3 opacity-0 hover:bg-surface-3 hover:text-text group-hover/row:opacity-100 focus-visible:opacity-100"
            >
              <GripVertical size={14} strokeWidth={1.75} />
            </span>
          ) : null}
        </td>
      )}
      <td className="w-[92px] whitespace-nowrap px-2">
        <Link
          to="/issues/$teamId/$projectKey/$issueKeySeq"
          params={{ teamId, projectKey: data.project.key, issueKeySeq: String(issue.keySeq) }}
          className="type-key text-text-3 hover:text-accent-text hover:underline"
        >
          {issueKey}
        </Link>
      </td>
      <td className="min-w-[280px] px-1">
        <div className="flex min-w-0 items-center gap-1">
          <PickerCell
            label={t("tableView.colType")}
            className="flex-none px-1.5"
            value={view.typeId}
            options={typeOptions}
            width={200}
            onSelect={(v) => v !== view.typeId && save({ typeId: v }, () => updateIssueTypeFn({ data: { issueId: issue.id, typeId: v } }))}
            display={<IssueTypeIcon type={type} size={16} />}
          />
          {renaming ? (
            <input
              autoFocus
              value={titleDraft}
              aria-label={t("tableView.colTitle")}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") {
                  setTitleDraft(issue.title);
                  setRenaming(false);
                }
              }}
              className="kp-field h-8 min-w-0 flex-1"
            />
          ) : (
            <>
              <Link
                to="/issues/$teamId/$projectKey/$issueKeySeq"
                params={{ teamId, projectKey: data.project.key, issueKeySeq: String(issue.keySeq) }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  setTitleDraft(view.title);
                  setRenaming(true);
                }}
                title={view.title}
                className="min-w-0 flex-1 truncate py-1.5 text-[14px] text-text hover:text-accent-text hover:underline"
              >
                {view.title}
              </Link>
              <button
                type="button"
                aria-label={t("tableEdit.rename")}
                title={t("tableEdit.rename")}
                onClick={() => {
                  setTitleDraft(view.title);
                  setRenaming(true);
                }}
                className="grid h-7 w-7 flex-none place-items-center rounded-[5px] text-text-3 opacity-0 hover:bg-surface-3 hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100"
              >
                <Pencil size={13} strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
      </td>
      <td className="w-[150px] px-1">
        <PickerCell
          label={t("tableView.colStatus")}
          value={view.columnId}
          options={statusOptions}
          onSelect={(columnId) => {
            const col = data.columns.find((c) => c.id === columnId);
            const toStatusId = col?.statusIds[0];
            if (!col || !toStatusId || columnId === view.columnId) return;
            save({ columnId, columnName: col.name, columnColor: col.color, statusId: toStatusId }, () =>
              moveIssueFn({ data: { issueId: issue.id, toStatusId } }),
            );
          }}
          display={<Lozenge color={view.columnColor}>{view.columnName}</Lozenge>}
        />
      </td>
      <td className="w-[180px] px-1">
        <PickerCell
          label={t("tableView.colAssignee")}
          value={view.assigneeId ?? ""}
          options={memberOptions}
          width={260}
          onSelect={(v) => {
            const next = v || null;
            if (next === view.assigneeId) return;
            save({ assigneeId: next }, () => updateIssueAssigneeFn({ data: { issueId: issue.id, assigneeId: next } }));
          }}
          display={
            assignee ? (
              <>
                <Avatar name={assignee.name} size={22} />
                <span className="truncate text-[13.5px]">{assignee.name}</span>
              </>
            ) : (
              <>
                <UnassignedAvatar size={22} />
                <span className="truncate text-[13.5px] text-text-3">{t("tableView.unassignedGroupLabel")}</span>
              </>
            )
          }
        />
      </td>
      <td className="w-[130px] px-1">
        <PickerCell
          label={t("tableView.colPriority")}
          value={view.priority}
          options={priorityOptions}
          width={200}
          onSelect={(v) => v !== view.priority && save({ priority: v }, () => updateIssuePriorityFn({ data: { issueId: issue.id, priority: v } }))}
          display={priority ? <PriorityIcon priority={priority} showLabel className="text-[13.5px] text-text-2" /> : <span className="text-text-3">{view.priority}</span>}
        />
      </td>
      <td className="w-[76px] px-1">
        <InlineInputCell
          label={t("tableView.colPoints")}
          type="number"
          align="right"
          initial={view.storyPoints == null ? "" : String(view.storyPoints)}
          onSave={(raw) => {
            const next = raw === "" ? null : Number(raw);
            if (next !== null && (Number.isNaN(next) || next < 0)) return;
            save({ storyPoints: next }, () => updateIssueStoryPointsFn({ data: { issueId: issue.id, storyPoints: next } }));
          }}
          display={
            view.storyPoints != null ? (
              <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[12px] font-semibold text-text-2">{view.storyPoints}</span>
            ) : (
              <span className="text-text-3">–</span>
            )
          }
        />
      </td>
      <td className="w-[128px] px-1 pr-2">
        <InlineInputCell
          label={t("tableView.colDueDate")}
          type="date"
          initial={toDateInput(view.dueDate)}
          onSave={(raw) => {
            // Noon local time, so the stored instant can't roll into the previous/next day across time zones.
            const next = raw ? new Date(`${raw}T12:00:00`) : null;
            save({ dueDate: next }, () => updateIssueDatesFn({ data: { issueId: issue.id, dueDate: next ? next.toISOString() : null } }));
          }}
          display={(() => {
            if (!view.dueDate) return <span className="text-text-3">–</span>;
            const d = new Date(view.dueDate);
            const overdue = d.getTime() < Date.now() - 86_400_000 && view.columnId !== data.columns.at(-1)?.id;
            return (
              <span className={cn("text-[13px]", overdue ? "font-medium text-danger" : "text-text-2")}>
                {d.toLocaleDateString(intlLocale, { day: "numeric", month: "short", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined })}
              </span>
            );
          })()}
        />
      </td>
    </tr>
  );
}

/** Toolbar chip that opens a SelectMenu. */
function ToolbarPicker({
  icon,
  label,
  options,
  value,
  onSelect,
  ariaLabel,
}: {
  icon?: ReactNode;
  label: ReactNode;
  options: SelectOption[];
  value: string;
  onSelect: (v: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[13px] text-text-2 hover:bg-surface-3 hover:text-text"
      >
        {icon}
        {label}
      </button>
      <SelectMenu open={open} onClose={() => setOpen(false)} anchorRef={ref} width={200} options={options} value={value} onSelect={onSelect} />
    </>
  );
}

export function TableView({ data, sprintContext }: { data: BoardData; sprintContext?: { sprintId: string; onReordered?: () => void } }) {
  const { t, i18n } = useTranslation("board");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const router = useRouter();
  const { openCreateIssue } = useWorkbench();
  const [error, setError] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const config = normalizeTableViewConfig(data.tableView.config);

  const orgMembers = data.orgMembers;
  const usersById = useMemo(() => {
    const map = new Map<string, { name: string }>();
    for (const u of data.users) map.set(u.id, u);
    for (const m of orgMembers) map.set(m.userId, { name: m.name });
    return map;
  }, [data.users, orgMembers]);
  const memberOptions = useMemo<SelectOption[]>(
    () => [
      { value: "", label: t("tableView.unassignedGroupLabel"), icon: <UnassignedAvatar size={20} /> },
      ...[...usersById.entries()]
        .sort((a, b) => a[1].name.localeCompare(b[1].name))
        .map(([id, u]) => ({ value: id, label: u.name, icon: <Avatar name={u.name} size={20} /> })),
    ],
    [usersById, t],
  );

  const flat: FlatIssue[] = data.columns.flatMap((col) =>
    col.issues.map((issue) => ({ ...issue, columnId: col.id, columnName: col.name, columnColor: col.color })),
  );
  const filtered = applyFilters(flat, config.filters);
  const sorted = sortIssues(filtered, config.sort, priorityOrderByKey(data.priorityLevels));
  const orderedIssueIds = sorted.map((i) => i.id);

  const groups: { key: string; label: string; lead?: ReactNode; issues: FlatIssue[] }[] =
    config.groupBy === "none"
      ? [{ key: "all", label: "", issues: sorted }]
      : config.groupBy === "column"
        ? data.columns
            .map((col) => ({ key: col.id, label: col.name, lead: <StatusDot color={col.color} />, issues: sorted.filter((i) => i.columnId === col.id) }))
            .filter((g) => g.issues.length > 0)
        : Object.values(
            sorted.reduce<Record<string, { key: string; label: string; lead?: ReactNode; issues: FlatIssue[] }>>((acc, issue) => {
              const key = issue.assigneeId ?? "__unassigned";
              const name = issue.assigneeId ? (usersById.get(issue.assigneeId)?.name ?? "—") : t("tableView.unassignedGroupLabel");
              acc[key] ??= {
                key,
                label: name,
                lead: issue.assigneeId ? <Avatar name={name} size={20} /> : <UnassignedAvatar size={20} />,
                issues: [],
              };
              acc[key].issues.push(issue);
              return acc;
            }, {}),
          ).sort((a, b) => (a.key === "__unassigned" ? 1 : b.key === "__unassigned" ? -1 : a.label.localeCompare(b.label)));

  async function updateConfig(patch: Partial<typeof config>) {
    const next = { ...config, ...patch };
    setError(null);
    try {
      await updateTableViewFn({
        data: { viewId: data.tableView.id, groupBy: next.groupBy, swimlaneBy: next.swimlaneBy, sort: next.sort, filters: next.filters },
      });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  function updateSortRule(index: number, patch: Partial<SortRule>) {
    updateConfig({ sort: config.sort.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  }
  function removeSortRule(index: number) {
    updateConfig({ sort: config.sort.filter((_, i) => i !== index) });
  }

  const manualModeActive = sprintContext != null && config.sort.length === 1 && config.sort[0]?.field === "manual";
  const showDragColumn = sprintContext != null;
  const columnCount = 7 + (showDragColumn ? 1 : 0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  async function handleDragEnd(event: DragEndEvent) {
    if (!manualModeActive || !sprintContext || reorderBusy) return;
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    const { beforeIssueId, afterIssueId } = computeReorderTargets(orderedIssueIds, activeId, overId);
    if (!beforeIssueId && !afterIssueId) return;

    setReorderBusy(true);
    setError(null);
    try {
      await reorderSprintIssueFn({ data: { sprintId: sprintContext.sprintId, issueId: activeId, beforeIssueId, afterIssueId } });
      sprintContext.onReordered?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setReorderBusy(false);
    }
  }

  const groupOptions: SelectOption[] = [
    { value: "column", label: t("tableView.groupByColumn") },
    { value: "assignee", label: t("tableView.groupByAssignee") },
    { value: "none", label: t("tableView.groupByNone") },
  ];
  const groupLabel = groupOptions.find((o) => o.value === config.groupBy)?.label;
  const unusedSortFields = SORT_FIELDS.filter((f) => !config.sort.some((r) => r.field === f));

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const th = "h-9 px-2 text-left text-[12.5px] font-medium text-text-3 whitespace-nowrap";

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="kp-table flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <ToolbarPicker
            ariaLabel={t("tableView.groupLabel")}
            icon={<Layers size={14} strokeWidth={1.75} />}
            label={
              <>
                <span className="text-text-3">{t("tableEdit.groupPrefix")}</span>
                <span className="font-medium text-text">{groupLabel}</span>
              </>
            }
            options={groupOptions}
            value={config.groupBy}
            onSelect={(v) => updateConfig({ groupBy: v as typeof config.groupBy })}
          />
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          {config.sort.map((rule, index) => (
            <span key={`${rule.field}-${index}`} className="inline-flex h-7 items-center rounded-[6px] bg-accent-soft text-[13px] text-accent-text">
              <button
                type="button"
                onClick={() => updateSortRule(index, { direction: rule.direction === "asc" ? "desc" : "asc" })}
                aria-label={t("tableEdit.toggleDirection")}
                title={t("tableEdit.toggleDirection")}
                className="grid h-7 w-7 place-items-center rounded-l-[6px] hover:bg-accent/15"
              >
                {rule.direction === "asc" ? <ArrowUp size={14} strokeWidth={2} /> : <ArrowDown size={14} strokeWidth={2} />}
              </button>
              <ToolbarSortField
                value={rule.field}
                options={SORT_FIELDS.filter((f) => f === rule.field || !config.sort.some((r) => r.field === f)).map((f) => ({ value: f, label: t(SORT_FIELD_LABEL_KEY[f]) }))}
                onSelect={(f) => updateSortRule(index, { field: f as SortField })}
                label={t(SORT_FIELD_LABEL_KEY[rule.field])}
              />
              {config.sort.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeSortRule(index)}
                  aria-label={t("tableEdit.removeSort")}
                  className="grid h-7 w-6 place-items-center rounded-r-[6px] hover:bg-accent/15"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </span>
          ))}
          {unusedSortFields.length > 0 && (
            <ToolbarPicker
              ariaLabel={t("tableView.addSortButton")}
              icon={<Plus size={14} strokeWidth={2} />}
              label={t("tableEdit.sort")}
              options={unusedSortFields.map((f) => ({ value: f, label: t(SORT_FIELD_LABEL_KEY[f]) }))}
              value=""
              onSelect={(f) => updateConfig({ sort: [...config.sort, { field: f as SortField, direction: "asc" }] })}
            />
          )}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <FilterBuilder
            filters={config.filters}
            options={{ columns: data.columns.map((c) => ({ name: c.name, color: c.color })), users: [...usersById.entries()].map(([id, u]) => ({ id, name: u.name })), priorityLevels: data.priorityLevels, issueTypes: data.issueTypes }}
            onChange={(filters) => updateConfig({ filters })}
          />
          {sprintContext && !manualModeActive && <span className="ml-2 text-[12.5px] text-text-3">{t("tableView.reorderDisabledHint")}</span>}
          <span className="ml-auto text-[12.5px] tabular-nums text-text-3">{t("tableEdit.issueCount", { count: sorted.length })}</span>
        </div>

        {error && <p className="rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}

        <div className="kp-table-scroll max-h-[calc(100vh-240px)] min-h-[160px] overflow-auto rounded-[8px] border border-border bg-surface">
          <table className="w-full min-w-[980px] border-separate border-spacing-0 text-[14px]">
            <thead className="sticky top-0 z-[5] bg-surface-2">
              <tr>
                {showDragColumn && <th className={cn(th, "w-7 border-b border-border")} aria-label={t("tableEdit.dragHandle")} />}
                <th className={cn(th, "border-b border-border")}>{t("tableView.colKey")}</th>
                <th className={cn(th, "border-b border-border pl-3")}>{t("tableView.colTitle")}</th>
                <th className={cn(th, "border-b border-border")}>{t("tableView.colStatus")}</th>
                <th className={cn(th, "border-b border-border")}>{t("tableView.colAssignee")}</th>
                <th className={cn(th, "border-b border-border")}>{t("tableView.colPriority")}</th>
                <th className={cn(th, "border-b border-border text-right")}>{t("tableView.colPoints")}</th>
                <th className={cn(th, "border-b border-border pr-3")}>{t("tableView.colDueDate")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const isCollapsed = collapsed.has(group.key);
                const points = group.issues.reduce((n, i) => n + (i.storyPoints ?? 0), 0);
                return (
                  <Fragment key={group.key}>
                    {group.label && (
                      <tr>
                        <td colSpan={columnCount} className="border-b border-border bg-surface-2/60 p-0">
                          <button
                            type="button"
                            onClick={() => toggleGroup(group.key)}
                            aria-expanded={!isCollapsed}
                            className="flex h-9 w-full items-center gap-2 px-2 text-left text-[13.5px] font-medium text-text hover:bg-surface-3"
                          >
                            <ChevronRight size={14} strokeWidth={2} className={cn("flex-none text-text-3 transition-transform", !isCollapsed && "rotate-90")} />
                            {group.lead}
                            <span className="truncate">{group.label}</span>
                            <CountPill>{group.issues.length}</CountPill>
                            {points > 0 && <span className="text-[12px] font-normal text-text-3">{t("tableEdit.pointsTotal", { count: points })}</span>}
                          </button>
                        </td>
                      </tr>
                    )}
                    {!isCollapsed &&
                      group.issues.map((issue) => (
                        <TableRow
                          key={issue.id}
                          issue={issue}
                          data={data}
                          usersById={usersById}
                          memberOptions={memberOptions}
                          showDragHandle={showDragColumn}
                          dragEnabled={manualModeActive}
                          intlLocale={intlLocale}
                        />
                      ))}
                  </Fragment>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={columnCount} className="border-b border-border px-3 py-10 text-center text-[14px] text-text-3">
                    {config.filters.length > 0 ? t("tableEdit.noMatches") : t("tableView.noIssues")}
                  </td>
                </tr>
              )}
              <tr>
                <td colSpan={columnCount} className="p-0">
                  <button
                    type="button"
                    onClick={() => openCreateIssue({ projectId: data.project.id, sprintId: sprintContext?.sprintId })}
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-[13.5px] text-text-2 hover:bg-surface-2 hover:text-text"
                  >
                    <Plus size={15} strokeWidth={2} />
                    {t("tableEdit.createIssue")}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </DndContext>
  );
}

function ToolbarSortField({ value, options, onSelect, label }: { value: string; options: SelectOption[]; onSelect: (v: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" onClick={() => setOpen((v) => !v)} className="h-7 px-1 pr-2 font-medium hover:underline">
        {label}
      </button>
      <SelectMenu open={open} onClose={() => setOpen(false)} anchorRef={ref} width={200} options={options} value={value} onSelect={onSelect} />
    </>
  );
}
