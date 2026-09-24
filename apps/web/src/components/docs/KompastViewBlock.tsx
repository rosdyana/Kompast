import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { createReactBlockSpec } from "@blocknote/react";
import { ArrowUpRight, KanbanSquare, Table2 } from "lucide-react";
import { Avatar } from "@kompast/ui/Avatar";
import { CountPill } from "@kompast/ui/Badge";
import { Lozenge, StatusDot } from "@kompast/ui/Lozenge";
import { IssueTypeIcon } from "@kompast/ui/IssueTypeIcon";
import { PriorityIcon } from "@kompast/ui/PriorityIcon";
import { SelectMenu } from "@kompast/ui/SelectMenu";
import { SkeletonRows } from "@kompast/ui/EmptyState";
import { normalizeTableViewConfig } from "@kompast/core/table-view-config";
import { useTranslation } from "@kompast/i18n";
import { getBoardEmbedDataFn, listEmbeddableBoardsFn } from "@/lib/server-fns/projects";
import { kompastViewBlockConfig } from "@/lib/blocknote-schema";
import { priorityOrderByKey, sortIssues, applyFilters } from "@/lib/table-view-utils";
import { ProjectIcon } from "@/components/shell/ProjectIcon";
import { cn } from "@/lib/cn";

type BoardData = Awaited<ReturnType<typeof getBoardEmbedDataFn>>;
type FlatIssue = BoardData["columns"][number]["issues"][number] & { columnId: string; columnName: string; columnColor: string };

/**
 * Read-only live embed of a project's saved view. No config mutation — the
 * same saved_view backs the project's Sprint Hub table (TableView.tsx
 * shares sortIssues/applyFilters with this file), so the embed never shows
 * a different set of rows than the live table would. The table/board
 * toggle is local to this viewer and never persisted.
 */
function EmbedView({ data }: { data: BoardData }) {
  const { t } = useTranslation("board");
  const [mode, setMode] = useState<"table" | "board">("table");
  const config = normalizeTableViewConfig(data.tableView.config);
  const usersById = new Map(data.users.map((u) => [u.id, u]));
  const typesById = new Map(data.issueTypes.map((tp) => [tp.id, tp]));
  const prioritiesByKey = new Map(data.priorityLevels.map((p) => [p.key, p]));
  const teamId = data.project.teamId ?? "none";

  const flat: FlatIssue[] = data.columns.flatMap((col) => col.issues.map((issue) => ({ ...issue, columnId: col.id, columnName: col.name, columnColor: col.color })));
  const filtered = applyFilters(flat, config.filters);
  const sorted = sortIssues(filtered, config.sort, priorityOrderByKey(data.priorityLevels));

  const issueLink = (issue: FlatIssue) => ({
    to: "/issues/$teamId/$projectKey/$issueKeySeq" as const,
    params: { teamId, projectKey: data.project.key, issueKeySeq: String(issue.keySeq) },
  });

  return (
    <div contentEditable={false} className="kp-embed my-1 w-full overflow-hidden rounded-[8px] border border-border bg-surface">
      <div className="flex h-10 items-center gap-2 border-b border-border bg-surface-2 px-3">
        <ProjectIcon projectKey={data.project.key} size={18} />
        <span className="min-w-0 truncate text-[13.5px] font-medium text-text">{data.project.name}</span>
        <CountPill>{sorted.length}</CountPill>
        <div className="ml-auto flex items-center gap-1">
          <div role="tablist" className="inline-flex rounded-[6px] bg-surface-3 p-0.5">
            {(["table", "board"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                aria-label={m === "table" ? t("kompastView.tableMode") : t("kompastView.boardMode")}
                title={m === "table" ? t("kompastView.tableMode") : t("kompastView.boardMode")}
                onClick={() => setMode(m)}
                className={cn("grid h-6 w-7 place-items-center rounded-[4px]", mode === m ? "bg-surface text-text shadow-card" : "text-text-3 hover:text-text")}
              >
                {m === "table" ? <Table2 size={14} /> : <KanbanSquare size={14} />}
              </button>
            ))}
          </div>
          <Link
            to="/projects/$teamId/$projectKey"
            params={{ teamId, projectKey: data.project.key }}
            search={{ tab: "table" }}
            className="inline-flex h-7 items-center gap-1 rounded-[6px] px-2 text-[12.5px] text-text-2 hover:bg-surface-3 hover:text-text"
          >
            {t("kompastView.open")}
            <ArrowUpRight size={13} />
          </Link>
        </div>
      </div>

      {mode === "table" ? (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full min-w-[640px] table-fixed border-separate border-spacing-0 text-[13.5px]">
            <thead className="sticky top-0 bg-surface">
              <tr className="text-left text-[12px] text-text-3">
                <th className="h-8 border-b border-border px-3 font-medium">{t("tableView.colTitle")}</th>
                <th className="h-8 w-[132px] border-b border-border px-2 font-medium">{t("tableView.colStatus")}</th>
                <th className="h-8 w-[150px] border-b border-border px-2 font-medium">{t("tableView.colAssignee")}</th>
                <th className="h-8 w-[112px] border-b border-border px-2 pr-3 font-medium">{t("tableView.colPriority")}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((issue) => {
                const assignee = issue.assigneeId ? usersById.get(issue.assigneeId) : undefined;
                const priority = prioritiesByKey.get(issue.priority);
                return (
                  <tr key={issue.id} className="hover:bg-surface-2">
                    <td className="h-9 border-b border-border px-3">
                      <Link {...issueLink(issue)} className="flex min-w-0 items-center gap-2 hover:text-accent-text">
                        <IssueTypeIcon type={typesById.get(issue.typeId)} size={16} />
                        <span className="type-key flex-none text-text-3">
                          {data.project.key}-{issue.keySeq}
                        </span>
                        <span className="truncate">{issue.title}</span>
                      </Link>
                    </td>
                    <td className="h-9 border-b border-border px-2">
                      <Lozenge color={issue.columnColor}>{issue.columnName}</Lozenge>
                    </td>
                    <td className="h-9 border-b border-border px-2">
                      {assignee ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Avatar name={assignee.name} size={20} />
                          <span className="truncate text-[13px]">{assignee.name}</span>
                        </span>
                      ) : (
                        <span className="text-text-3">–</span>
                      )}
                    </td>
                    <td className="h-9 border-b border-border px-2 pr-3">
                      {priority ? <PriorityIcon priority={priority} showLabel className="text-[13px] text-text-2" /> : <span className="text-text-3">{issue.priority}</span>}
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-text-3">
                    {t("tableView.noIssues")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex max-h-[460px] gap-2.5 overflow-auto bg-surface-2 p-2.5">
          {data.columns.map((col) => {
            const issues = sorted.filter((i) => i.columnId === col.id);
            return (
              <div key={col.id} className="flex w-[230px] flex-none flex-col gap-1.5 rounded-[8px] bg-surface-3/60 p-1.5">
                <div className="flex h-7 items-center gap-1.5 px-1.5 type-label-overline text-text-2">
                  <StatusDot color={col.color} />
                  <span className="truncate">{col.name}</span>
                  <span className="font-normal tabular-nums text-text-3">{issues.length}</span>
                </div>
                {issues.map((issue) => {
                  const assignee = issue.assigneeId ? usersById.get(issue.assigneeId) : undefined;
                  const priority = prioritiesByKey.get(issue.priority);
                  return (
                    <Link key={issue.id} {...issueLink(issue)} className="flex flex-col gap-2 rounded-[6px] bg-surface p-2.5 shadow-card hover:bg-surface-2">
                      <span className="line-clamp-2 text-[13.5px] leading-snug text-text">{issue.title}</span>
                      <span className="flex items-center gap-1.5">
                        <IssueTypeIcon type={typesById.get(issue.typeId)} size={14} />
                        <span className="type-key text-text-3">
                          {data.project.key}-{issue.keySeq}
                        </span>
                        <span className="ml-auto flex items-center gap-1.5">
                          {priority && <PriorityIcon priority={priority} size={14} />}
                          {assignee && <Avatar name={assignee.name} size={18} />}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type Boards = Awaited<ReturnType<typeof listEmbeddableBoardsFn>>;

function BoardPicker({ onPick }: { onPick: (boardId: string) => void }) {
  const { t } = useTranslation("board");
  const [boards, setBoards] = useState<Boards | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    listEmbeddableBoardsFn().then(setBoards);
  }, []);

  return (
    <div contentEditable={false} className="my-1 flex w-full flex-wrap items-center gap-3 rounded-[8px] border border-dashed border-border-2 bg-surface-2 px-4 py-3">
      <span className="grid h-8 w-8 flex-none place-items-center rounded-[6px] bg-surface-3 text-text-2">
        <KanbanSquare size={16} />
      </span>
      <span className="min-w-0 flex-1 text-[13.5px] text-text-2">
        {boards !== null && boards.length === 0 ? t("tableView.noProjectsWithBoard") : t("tableView.embedInsertPrompt")}
      </span>
      {boards === null ? (
        <span className="text-[13px] text-text-3">{t("loadingEllipsis")}</span>
      ) : (
        boards.length > 0 && (
          <>
            <button
              ref={ref}
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-border-2 bg-surface px-3 text-[13.5px] font-medium hover:bg-surface-2"
            >
              {t("tableView.selectProjectPlaceholder")}
            </button>
            <SelectMenu
              open={open}
              onClose={() => setOpen(false)}
              anchorRef={ref}
              width={280}
              value=""
              options={boards.map((b) => ({ value: b.boardId, label: b.projectName, hint: b.projectKey, icon: <ProjectIcon projectKey={b.projectKey} size={18} /> }))}
              onSelect={onPick}
            />
          </>
        )
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
        <div contentEditable={false} className="my-1 w-full rounded-[8px] border border-border bg-surface-2 px-4 py-3 text-[13.5px] text-text-3">
          {t("tableView.boardNotFoundOrDeleted")}
        </div>
      );
    }

    if (!data) {
      return (
        <div contentEditable={false} aria-label={t("tableView.loadingTable")} className="my-1 w-full rounded-[8px] border border-border bg-surface p-3">
          <SkeletonRows rows={3} />
        </div>
      );
    }

    return <EmbedView data={data} />;
  },
});
