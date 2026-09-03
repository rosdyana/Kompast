import { Fragment } from "react";
import { useRouter, Link } from "@tanstack/react-router";
import { Avatar } from "@kompast/ui/Avatar";
import type { TableViewConfig } from "@kompast/core";
import { getProjectBoardFn } from "@/lib/server-fns/projects";
import { updateTableViewFn } from "@/lib/server-fns/projects";

type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;
type FlatIssue = BoardData["columns"][number]["issues"][number] & { columnName: string; columnColor: string };

const PRIORITY_ORDER: Record<string, number> = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function sortIssues(issues: FlatIssue[], sortBy: TableViewConfig["sortBy"], sortDir: "asc" | "desc") {
  const sorted = [...issues].sort((a, b) => {
    let cmp = 0;
    if (sortBy === "rank") cmp = a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
    else if (sortBy === "priority") cmp = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
    else if (sortBy === "dueDate") cmp = (a.dueDate ? new Date(a.dueDate).getTime() : Infinity) - (b.dueDate ? new Date(b.dueDate).getTime() : Infinity);
    else if (sortBy === "points") cmp = (a.storyPoints ?? -1) - (b.storyPoints ?? -1);
    else if (sortBy === "key") cmp = a.keySeq - b.keySeq;
    return sortDir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

export function TableView({ data }: { data: BoardData }) {
  const router = useRouter();
  const config = data.tableView.config as unknown as TableViewConfig;
  const usersById = new Map(data.users.map((u) => [u.id, u]));
  const issueTypesById = new Map(data.issueTypes.map((t) => [t.id, t]));

  const flat: FlatIssue[] = data.columns.flatMap((col) =>
    col.issues.map((issue) => ({ ...issue, columnName: col.name, columnColor: col.color })),
  );
  const sorted = sortIssues(flat, config.sortBy, config.sortDir);

  const groups: { label: string; issues: FlatIssue[] }[] =
    config.groupBy === "none"
      ? [{ label: "", issues: sorted }]
      : config.groupBy === "column"
        ? data.columns
            .map((col) => ({ label: col.name, issues: sorted.filter((i) => i.columnName === col.name) }))
            .filter((g) => g.issues.length > 0)
        : Object.entries(
            sorted.reduce<Record<string, FlatIssue[]>>((acc, issue) => {
              const key = issue.assigneeId ? (usersById.get(issue.assigneeId)?.name ?? "Unknown") : "Belum ditugaskan";
              (acc[key] ??= []).push(issue);
              return acc;
            }, {}),
          ).map(([label, issues]) => ({ label, issues }));

  async function updateConfig(patch: Partial<typeof config>) {
    const next = { ...config, ...patch };
    await updateTableViewFn({ data: { viewId: data.tableView.id, ...next } });
    await router.invalidate();
  }

  return (
    <div className="px-6 py-4">
      <div className="mb-4 flex items-center gap-3 text-[12.5px]">
        <label className="flex items-center gap-1.5 text-text-2">
          Grup:
          <select
            value={config.groupBy}
            onChange={(e) => updateConfig({ groupBy: e.target.value as typeof config.groupBy })}
            className="rounded-md border border-border bg-surface px-1.5 py-1 text-[12px]"
          >
            <option value="column">Status</option>
            <option value="assignee">Assignee</option>
            <option value="none">Tidak ada</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-text-2">
          Urutkan:
          <select
            value={config.sortBy}
            onChange={(e) => updateConfig({ sortBy: e.target.value as typeof config.sortBy })}
            className="rounded-md border border-border bg-surface px-1.5 py-1 text-[12px]"
          >
            <option value="rank">Urutan board</option>
            <option value="priority">Prioritas</option>
            <option value="dueDate">Jatuh tempo</option>
            <option value="points">Poin</option>
            <option value="key">Key</option>
          </select>
          <button
            onClick={() => updateConfig({ sortDir: config.sortDir === "asc" ? "desc" : "asc" })}
            className="rounded-md border border-border px-1.5 py-1 text-[12px] hover:bg-surface-3"
          >
            {config.sortDir === "asc" ? "↑" : "↓"}
          </button>
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left text-text-3">
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Tipe</th>
              <th className="px-3 py-2 font-medium">Judul</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Assignee</th>
              <th className="px-3 py-2 font-medium">Prioritas</th>
              <th className="px-3 py-2 font-medium">Poin</th>
              <th className="px-3 py-2 font-medium">Jatuh tempo</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group, i) => (
              <Fragment key={group.label || `group-${i}`}>
                {group.label && (
                  <tr className="bg-surface-2">
                    <td colSpan={8} className="px-3 py-1.5 text-[11px] font-semibold text-text-2">
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
                          to="/issues/$projectKey/$issueKeySeq"
                          params={{ projectKey: data.project.key, issueKeySeq: String(issue.keySeq) }}
                          className="font-mono text-text-3 hover:text-accent"
                        >
                          {data.project.key}-{issue.keySeq}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-text-2">{type?.name ?? "—"}</td>
                      <td className="px-3 py-2">{issue.title}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: issue.columnColor }} />
                          {issue.columnName}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {assignee ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Avatar initials={initialsOf(assignee.name)} size={18} />
                            {assignee.name}
                          </span>
                        ) : (
                          <span className="text-text-3">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 capitalize text-text-2">{issue.priority}</td>
                      <td className="px-3 py-2 font-mono text-text-2">{issue.storyPoints ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-text-2">
                        {issue.dueDate ? new Date(issue.dueDate).toLocaleDateString("id-ID", { day: "numeric", month: "short" }) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-text-3">
                  Tidak ada tiket.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
