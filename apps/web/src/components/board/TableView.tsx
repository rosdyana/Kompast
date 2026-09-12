import { Fragment, useState } from "react";
import { useRouter, Link } from "@tanstack/react-router";
import { ArrowUp, ArrowDown, GripVertical, Plus, X } from "lucide-react";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { Avatar } from "@kompast/ui/Avatar";
import { normalizeTableViewConfig, type SortField, type SortRule } from "@kompast/core/table-view-config";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { getProjectBoardFn, updateTableViewFn } from "@/lib/server-fns/projects";
import { reorderSprintIssueFn } from "@/lib/server-fns/sprints";
import { priorityOrderByKey, sortIssues, applyFilters, computeReorderTargets } from "@/lib/table-view-utils";
import { FilterBuilder } from "./FilterBuilder";

type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;
type FlatIssue = BoardData["columns"][number]["issues"][number] & { columnName: string; columnColor: string; sprintRank?: string | null };

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };
const SORT_FIELDS: SortField[] = ["manual", "priority", "dueDate", "points", "key"];
const SORT_FIELD_LABEL_KEY: Record<SortField, string> = {
  manual: "tableView.sortByManual",
  priority: "tableView.sortByPriority",
  dueDate: "tableView.sortByDueDate",
  points: "tableView.sortByPoints",
  key: "tableView.sortByKey",
};

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * A row's drag handle + drop target. A separate component (not inlined in
 * the map callback) because useDraggable/useDroppable are hooks and must run
 * unconditionally per row.
 */
function ReviewRow({
  issue,
  type,
  assignee,
  showDragHandle,
  dragEnabled,
  projectKey,
  teamId,
  intlLocale,
}: {
  issue: FlatIssue;
  type: { name: string } | undefined;
  assignee: { name: string } | undefined;
  showDragHandle: boolean;
  dragEnabled: boolean;
  projectKey: string;
  teamId: string | null;
  intlLocale: string;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({ id: issue.id, disabled: !dragEnabled });
  const { setNodeRef: setDropRef } = useDroppable({ id: issue.id });
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, opacity: isDragging ? 0.4 : 1 } : undefined;

  return (
    <tr ref={setDropRef} style={style} className="relative border-b border-border bg-surface last:border-b-0 hover:bg-surface-2">
      {showDragHandle && (
        <td className="w-6 px-1.5 py-2">
          {dragEnabled && (
            <span ref={setDragRef} {...listeners} {...attributes} className="cursor-grab text-text-3 hover:text-text-1">
              <GripVertical size={14} strokeWidth={1.75} />
            </span>
          )}
        </td>
      )}
      <td className="px-3 py-2">
        <Link
          to="/issues/$teamId/$projectKey/$issueKeySeq"
          params={{ teamId: teamId ?? "none", projectKey, issueKeySeq: String(issue.keySeq) }}
          className="font-mono text-text-3 hover:text-accent"
        >
          {projectKey}-{issue.keySeq}
        </Link>
      </td>
      <td className="px-3 py-2 text-text-2">{type?.name ?? "—"}</td>
      <td className="max-w-[360px] truncate px-3 py-2" title={issue.title}>
        {issue.title}
      </td>
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: issue.columnColor }} />
          {issue.columnName}
        </span>
      </td>
      <td className="px-3 py-2">
        {assignee ? (
          <span className="inline-flex items-center gap-1.5">
            <Avatar initials={initialsOf(assignee.name)} />
            {assignee.name}
          </span>
        ) : (
          <span className="text-text-3">—</span>
        )}
      </td>
      <td className="px-3 py-2 capitalize text-text-2">{issue.priority}</td>
      <td className="px-3 py-2 font-mono text-text-2">{issue.storyPoints ?? "—"}</td>
      <td className="px-3 py-2 font-mono text-text-2">
        {issue.dueDate ? new Date(issue.dueDate).toLocaleDateString(intlLocale, { day: "numeric", month: "short" }) : "—"}
      </td>
    </tr>
  );
}

export function TableView({ data, sprintContext }: { data: BoardData; sprintContext?: { sprintId: string; onReordered?: () => void } }) {
  const { t, i18n } = useTranslation("board");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [reorderBusy, setReorderBusy] = useState(false);
  const config = normalizeTableViewConfig(data.tableView.config);
  const usersById = new Map(data.users.map((u) => [u.id, u]));
  const issueTypesById = new Map(data.issueTypes.map((tp) => [tp.id, tp]));

  const flat: FlatIssue[] = data.columns.flatMap((col) =>
    col.issues.map((issue) => ({ ...issue, columnName: col.name, columnColor: col.color })),
  );
  const filtered = applyFilters(flat, config.filters);
  const sorted = sortIssues(filtered, config.sort, priorityOrderByKey(data.priorityLevels));
  const orderedIssueIds = sorted.map((i) => i.id);

  const groups: { label: string; issues: FlatIssue[] }[] =
    config.groupBy === "none"
      ? [{ label: "", issues: sorted }]
      : config.groupBy === "column"
        ? data.columns
            .map((col) => ({ label: col.name, issues: sorted.filter((i) => i.columnName === col.name) }))
            .filter((g) => g.issues.length > 0)
        : Object.entries(
            sorted.reduce<Record<string, FlatIssue[]>>((acc, issue) => {
              const key = issue.assigneeId ? (usersById.get(issue.assigneeId)?.name ?? "Unknown") : t("tableView.unassignedGroupLabel");
              (acc[key] ??= []).push(issue);
              return acc;
            }, {}),
          ).map(([label, issues]) => ({ label, issues }));

  async function updateConfig(patch: Partial<typeof config>) {
    const next = { ...config, ...patch };
    setError(null);
    try {
      await updateTableViewFn({ data: { viewId: data.tableView.id, groupBy: next.groupBy, sort: next.sort, filters: next.filters } });
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
  function addSortRule() {
    const unused = SORT_FIELDS.find((f) => !config.sort.some((r) => r.field === f));
    if (!unused) return;
    updateConfig({ sort: [...config.sort, { field: unused, direction: "asc" }] });
  }

  const manualModeActive = sprintContext != null && config.sort.length === 1 && config.sort[0]?.field === "manual";
  const showDragColumn = sprintContext != null;
  const columnCount = 8 + (showDragColumn ? 1 : 0);

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

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="px-6 py-4">
        <div className="mb-4 flex flex-wrap items-center gap-3 text-[12.5px]">
          <label className="flex items-center gap-1.5 text-text-2">
            {t("tableView.groupLabel")}
            <select
              value={config.groupBy}
              onChange={(e) => updateConfig({ groupBy: e.target.value as typeof config.groupBy })}
              className="kp-select rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
            >
              <option value="column">{t("tableView.groupByColumn")}</option>
              <option value="assignee">{t("tableView.groupByAssignee")}</option>
              <option value="none">{t("tableView.groupByNone")}</option>
            </select>
          </label>

          <div className="flex flex-wrap items-center gap-1.5 text-text-2">
            {t("tableView.sortLabel")}
            {config.sort.map((rule, index) => (
              <span key={index} className="flex items-center gap-1">
                <select
                  value={rule.field}
                  onChange={(e) => updateSortRule(index, { field: e.target.value as SortField })}
                  className="kp-select rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
                >
                  {SORT_FIELDS.map((f) => (
                    <option key={f} value={f} disabled={f !== rule.field && config.sort.some((r) => r.field === f)}>
                      {t(SORT_FIELD_LABEL_KEY[f])}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => updateSortRule(index, { direction: rule.direction === "asc" ? "desc" : "asc" })}
                  className="rounded-[7px] border border-border px-1.5 py-1 hover:bg-surface-3"
                >
                  {rule.direction === "asc" ? <ArrowUp size={14} strokeWidth={1.75} /> : <ArrowDown size={14} strokeWidth={1.75} />}
                </button>
                {config.sort.length > 1 && (
                  <button onClick={() => removeSortRule(index)} className="rounded-[7px] p-1 text-text-3 hover:bg-surface-3 hover:text-danger">
                    <X size={13} strokeWidth={1.75} />
                  </button>
                )}
              </span>
            ))}
            {config.sort.length < SORT_FIELDS.length && (
              <button onClick={addSortRule} className="flex items-center gap-1 rounded-[7px] border border-border px-1.5 py-1 hover:bg-surface-3">
                <Plus size={13} strokeWidth={1.75} /> {t("tableView.addSortButton")}
              </button>
            )}
          </div>

          <FilterBuilder
            filters={config.filters}
            options={{ columns: data.columns.map((c) => ({ name: c.name })), users: data.users, priorityLevels: data.priorityLevels, issueTypes: data.issueTypes }}
            onChange={(filters) => updateConfig({ filters })}
          />

          {sprintContext && !manualModeActive && <span className="type-body text-text-3">{t("tableView.reorderDisabledHint")}</span>}
        </div>

        {error && (
          <p className="mb-3 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>
        )}

        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-left text-text-3">
                {showDragColumn && <th className="w-6 px-1.5 py-2" />}
                <th className="px-3 py-2 font-medium">{t("tableView.colKey")}</th>
                <th className="px-3 py-2 font-medium">{t("tableView.colType")}</th>
                <th className="px-3 py-2 font-medium">{t("tableView.colTitle")}</th>
                <th className="px-3 py-2 font-medium">{t("tableView.colStatus")}</th>
                <th className="px-3 py-2 font-medium">{t("tableView.colAssignee")}</th>
                <th className="px-3 py-2 font-medium">{t("tableView.colPriority")}</th>
                <th className="px-3 py-2 font-medium">{t("tableView.colPoints")}</th>
                <th className="px-3 py-2 font-medium">{t("tableView.colDueDate")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group, i) => (
                <Fragment key={group.label || `group-${i}`}>
                  {group.label && (
                    <tr className="bg-surface-2">
                      <td colSpan={columnCount} className="px-3 py-1.5 type-body font-semibold text-text-2">
                        {group.label} · {group.issues.length}
                      </td>
                    </tr>
                  )}
                  {group.issues.map((issue) => (
                    <ReviewRow
                      key={issue.id}
                      issue={issue}
                      type={issueTypesById.get(issue.typeId)}
                      assignee={issue.assigneeId ? usersById.get(issue.assigneeId) : undefined}
                      showDragHandle={showDragColumn}
                      dragEnabled={manualModeActive}
                      projectKey={data.project.key}
                      teamId={data.project.teamId}
                      intlLocale={intlLocale}
                    />
                  ))}
                </Fragment>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={columnCount} className="px-3 py-8 text-center text-text-3">
                    {t("tableView.noIssues")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </DndContext>
  );
}
