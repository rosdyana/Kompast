import { Fragment, useState } from "react";
import { useRouter, Link } from "@tanstack/react-router";
import { ArrowUp, ArrowDown } from "lucide-react";
import { Avatar } from "@kompast/ui/Avatar";
import type { TableViewConfig } from "@kompast/core";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { getProjectBoardFn } from "@/lib/server-fns/projects";
import { updateTableViewFn } from "@/lib/server-fns/projects";

type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;
type FlatIssue = BoardData["columns"][number]["issues"][number] & { columnName: string; columnColor: string };

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * `priority_level.order` is ascending-severity (0 = lowest). The table's
 * "Sort: Priority" wants descending severity (highest first), so invert:
 * the level with `order: 0` gets the highest index, sorting last — matching
 * the old static map's `lowest: 4` behavior, but derived from real per-project
 * data instead of a fixed 5-value enum (new projects don't use lowest/…/highest keys).
 */
function priorityOrderByKey(priorityLevels: { key: string; order: number }[]): Record<string, number> {
  const sorted = [...priorityLevels].sort((a, b) => a.order - b.order);
  return Object.fromEntries(sorted.map((p, i, arr) => [p.key, arr.length - 1 - i]));
}

function sortIssues(issues: FlatIssue[], sortBy: TableViewConfig["sortBy"], sortDir: "asc" | "desc", priorityOrder: Record<string, number>) {
  const sorted = [...issues].sort((a, b) => {
    let cmp = 0;
    if (sortBy === "rank") cmp = a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
    else if (sortBy === "priority") cmp = (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99);
    else if (sortBy === "dueDate") cmp = (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) - (b.dueDate ? new Date(b.dueDate).getTime() : Infinity);
    else if (sortBy === "points") cmp = (a.storyPoints ?? -1) - (b.storyPoints ?? -1);
    else if (sortBy === "key") cmp = a.keySeq - b.keySeq;
    return sortDir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

export function TableView({ data }: { data: BoardData }) {
  const { t, i18n } = useTranslation("board");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const config = data.tableView.config as unknown as TableViewConfig;
  const usersById = new Map(data.users.map((u) => [u.id, u]));
  const issueTypesById = new Map(data.issueTypes.map((tp) => [tp.id, tp]));

  const flat: FlatIssue[] = data.columns.flatMap((col) =>
    col.issues.map((issue) => ({ ...issue, columnName: col.name, columnColor: col.color })),
  );
  const sorted = sortIssues(flat, config.sortBy, config.sortDir, priorityOrderByKey(data.priorityLevels));

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
      await updateTableViewFn({ data: { viewId: data.tableView.id, ...next } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  return (
    <div className="px-6 py-4">
      <div className="mb-4 flex items-center gap-3 text-[12.5px]">
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
        <label className="flex items-center gap-1.5 text-text-2">
          {t("tableView.sortLabel")}
          <select
            value={config.sortBy}
            onChange={(e) => updateConfig({ sortBy: e.target.value as typeof config.sortBy })}
            className="kp-select rounded-[7px] border border-border bg-surface px-1.5 py-1 text-[12.5px]"
          >
            <option value="rank">{t("tableView.sortByRank")}</option>
            <option value="priority">{t("tableView.sortByPriority")}</option>
            <option value="dueDate">{t("tableView.sortByDueDate")}</option>
            <option value="points">{t("tableView.sortByPoints")}</option>
            <option value="key">{t("tableView.sortByKey")}</option>
          </select>
          <button
            onClick={() => updateConfig({ sortDir: config.sortDir === "asc" ? "desc" : "asc" })}
            className="rounded-[7px] border border-border px-1.5 py-1 hover:bg-surface-3"
          >
            {config.sortDir === "asc" ? <ArrowUp size={14} strokeWidth={1.75} /> : <ArrowDown size={14} strokeWidth={1.75} />}
          </button>
        </label>
      </div>

      {error && (
        <p className="mb-3 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left text-text-3">
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
                    <td colSpan={8} className="px-3 py-1.5 type-body font-semibold text-text-2">
                      {group.label} · {group.issues.length}
                    </td>
                  </tr>
                )}
                {group.issues.map((issue) => {
                  const type = issueTypesById.get(issue.typeId);
                  const assignee = issue.assigneeId ? usersById.get(issue.assigneeId) : undefined;
                  return (
                    <tr key={issue.id} className="border-b border-border bg-surface last:border-b-0 hover:bg-surface-2">
                      <td className="px-3 py-2">
                        <Link
                          to="/issues/$teamId/$projectKey/$issueKeySeq"
                          params={{ teamId: data.project.teamId ?? "none", projectKey: data.project.key, issueKeySeq: String(issue.keySeq) }}
                          className="font-mono text-text-3 hover:text-accent"
                        >
                          {data.project.key}-{issue.keySeq}
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
                })}
              </Fragment>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-text-3">
                  {t("tableView.noIssues")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
