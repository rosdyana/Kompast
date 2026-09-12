import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { createReactBlockSpec } from "@blocknote/react";
import { Avatar } from "@kompast/ui/Avatar";
import { normalizeTableViewConfig } from "@kompast/core/table-view-config";
import { useTranslation } from "@kompast/i18n";
import { getBoardEmbedDataFn, listEmbeddableBoardsFn } from "@/lib/server-fns/projects";
import { kompastViewBlockConfig } from "@/lib/blocknote-schema";
import { priorityOrderByKey, sortIssues, applyFilters } from "@/lib/table-view-utils";

type BoardData = Awaited<ReturnType<typeof getBoardEmbedDataFn>>;
type FlatIssue = BoardData["columns"][number]["issues"][number] & { columnName: string; columnColor: string };

function initialsOf(name: string) {
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

/**
 * No grouping/sort/filter controls, no config mutation — the same
 * saved_view backs the project's own Table tab (see TableView.tsx, which
 * shares sortIssues/applyFilters with this file), an embed only ever reads
 * it, filters included, so the embed never shows a different set of rows
 * than the live table would.
 */
function ReadOnlyTable({ data }: { data: BoardData }) {
  const { t } = useTranslation("board");
  const config = normalizeTableViewConfig(data.tableView.config);
  const usersById = new Map(data.users.map((u) => [u.id, u]));

  const flat: FlatIssue[] = data.columns.flatMap((col) => col.issues.map((issue) => ({ ...issue, columnName: col.name, columnColor: col.color })));
  const filtered = applyFilters(flat, config.filters);
  const sorted = sortIssues(filtered, config.sort, priorityOrderByKey(data.priorityLevels));

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5 text-[11px] text-text-3">
        <span>
          {data.project.key} · {data.project.name}
        </span>
        <Link
          to="/projects/$teamId/$projectKey"
          params={{ teamId: data.project.teamId ?? "none", projectKey: data.project.key }}
          className="hover:text-accent"
        >
          {t("tableView.openInProjectLink")}
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left text-text-3">
              <th className="px-3 py-1.5 font-medium">{t("tableView.colKey")}</th>
              <th className="px-3 py-1.5 font-medium">{t("tableView.colTitle")}</th>
              <th className="px-3 py-1.5 font-medium">{t("tableView.colStatus")}</th>
              <th className="px-3 py-1.5 font-medium">{t("tableView.colAssignee")}</th>
              <th className="px-3 py-1.5 font-medium">{t("tableView.colPriority")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((issue) => {
              const assignee = issue.assigneeId ? usersById.get(issue.assigneeId) : undefined;
              return (
                <tr key={issue.id} className="border-b border-border bg-surface last:border-b-0 hover:bg-surface-2">
                  <td className="px-3 py-1.5">
                    <Link
                      to="/issues/$teamId/$projectKey/$issueKeySeq"
                      params={{ teamId: data.project.teamId ?? "none", projectKey: data.project.key, issueKeySeq: String(issue.keySeq) }}
                      className="font-mono text-text-3 hover:text-accent"
                    >
                      {data.project.key}-{issue.keySeq}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5">{issue.title}</td>
                  <td className="px-3 py-1.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: issue.columnColor }} />
                      {issue.columnName}
                    </span>
                  </td>
                  <td className="px-3 py-1.5">
                    {assignee ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Avatar initials={initialsOf(assignee.name)} size={16} />
                        {assignee.name}
                      </span>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 capitalize text-text-2">{issue.priority}</td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-text-3">
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

type Boards = Awaited<ReturnType<typeof listEmbeddableBoardsFn>>;

function BoardPicker({ onPick }: { onPick: (boardId: string) => void }) {
  const { t } = useTranslation("board");
  const [boards, setBoards] = useState<Boards | null>(null);

  useEffect(() => {
    listEmbeddableBoardsFn().then(setBoards);
  }, []);

  return (
    <div className="rounded-xl border border-dashed border-border-2 bg-surface-2 p-4 text-[12.5px]">
      <p className="mb-2 text-text-2">{t("tableView.embedInsertPrompt")}</p>
      {boards === null && <p className="text-text-3">{t("loadingEllipsis")}</p>}
      {boards !== null && boards.length === 0 && <p className="text-text-3">{t("tableView.noProjectsWithBoard")}</p>}
      {boards !== null && boards.length > 0 && (
        <select
          defaultValue=""
          onChange={(e) => e.target.value && onPick(e.target.value)}
          className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 outline-none"
        >
          <option value="" disabled>
            {t("tableView.selectProjectPlaceholder")}
          </option>
          {boards.map((b) => (
            <option key={b.boardId} value={b.boardId}>
              {b.projectKey} · {b.projectName}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export const kompastViewBlockSpec = createReactBlockSpec(kompastViewBlockConfig, {
  render: ({ block, editor }) => {
    const { t } = useTranslation("board");
    const [data, setData] = useState<BoardData | null>(null);
    const [error, setError] = useState(false);

    useEffect(() => {
      if (!block.props.boardId) return;
      getBoardEmbedDataFn({ data: block.props.boardId })
        .then(setData)
        .catch(() => setError(true));
    }, [block.props.boardId]);

    if (!block.props.boardId) {
      return (
        <BoardPicker
          onPick={(boardId) => editor.updateBlock(block, { props: { ...block.props, boardId } })}
        />
      );
    }

    if (error) {
      return (
        <div className="rounded-xl border border-border bg-surface-2 p-4 text-[12.5px] text-text-3">
          {t("tableView.boardNotFoundOrDeleted")}
        </div>
      );
    }

    if (!data) {
      return <div className="rounded-xl border border-border bg-surface-2 p-4 text-[12.5px] text-text-3">{t("tableView.loadingTable")}</div>;
    }

    return <ReadOnlyTable data={data} />;
  },
});
