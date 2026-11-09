import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Table2 } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { SearchField, NativeSelect } from "@kompast/ui/Input";
import { useTranslation } from "@kompast/i18n";
import {
  countSelection,
  isImplied,
  searchVisible,
  setAllDestinations,
  setRootDestination,
  toggleRoot,
  visibleRows,
  type NotionTargetChoice,
  type NotionTree,
  type RootSelection,
} from "@/lib/notion-migration-tree";
import { cn } from "@/lib/cn";
import { TargetSelect, targetFromValue, type TeamOption } from "./shared";

interface PickStepProps {
  tree: NotionTree;
  truncated: boolean;
  selection: RootSelection;
  onChange: (next: RootSelection) => void;
  /** Destination a newly checked root gets. */
  defaultTarget: NotionTargetChoice;
  canImportToWorkspace: boolean;
  teams: TeamOption[];
  busy: boolean;
  onRescan: () => void;
  onReview: () => void;
}

/**
 * Step 3: the discovered pages as a collapsible tree. Checking a page brings
 * it and everything under it; children of a checked page show as included and
 * can't be unchecked on their own. Each checked root gets a destination.
 */
export function PickStep({ tree, truncated, selection, onChange, defaultTarget, canImportToWorkspace, teams, busy, onRescan, onReview }: PickStepProps) {
  const { t } = useTranslation("docs");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const visible = useMemo(() => searchVisible(tree, query), [tree, query]);
  const rows = useMemo(() => visibleRows(tree, expanded, visible), [tree, expanded, visible]);
  const counts = useMemo(() => countSelection(tree, selection), [tree, selection]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (tree.order.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="rounded-[6px] bg-surface-2 px-3 py-2 text-[13.5px] text-text-2">{t("notionMigration.pick.empty")}</p>
        <div>
          <Button variant="outline" onClick={onRescan} disabled={busy}>
            {t("notionMigration.pick.scanAgain")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {truncated && <p className="rounded-[6px] bg-surface-2 px-3 py-2 text-[13px] text-text-2">{t("notionMigration.pick.truncated")}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <SearchField
          wrapperClassName="min-w-[220px] flex-1"
          placeholder={t("notionMigration.pick.search")}
          aria-label={t("notionMigration.pick.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          clearLabel={t("notionMigration.pick.clearSearch")}
        />
        <label className="flex items-center gap-2 text-[13px] text-text-2">
          <span className="whitespace-nowrap">{t("notionMigration.pick.setAll")}</span>
          <NativeSelect
            aria-label={t("notionMigration.pick.setAll")}
            value=""
            disabled={busy || selection.size === 0}
            onChange={(e) => {
              if (e.target.value) onChange(setAllDestinations(selection, targetFromValue(e.target.value)));
            }}
            className="h-8 w-auto min-w-[160px] py-0 text-[13px]"
          >
            <option value="">{t("notionMigration.pick.setAllPlaceholder")}</option>
            {canImportToWorkspace && <option value="workspace">{t("notionImport.workspace")}</option>}
            <option value="private">{t("notionImport.private")}</option>
            {teams.map((team) => (
              <option key={team.id} value={`team:${team.id}`}>
                {team.name}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>

      <p className="text-[13px] text-text-3">{t("notionMigration.pick.selectedCount", { count: counts.roots })}</p>

      <ul role="tree" aria-label={t("notionMigration.pick.heading")} className="max-h-[52vh] overflow-auto rounded-[8px] border border-border bg-surface">
        {rows.length === 0 && <li className="px-3 py-4 text-[13.5px] text-text-3">{t("notionMigration.pick.noMatches", { query: query.trim() })}</li>}
        {rows.map((row) => {
          const node = tree.nodes.get(row.id);
          if (!node) return null;
          const implied = isImplied(tree, row.id, selection);
          const checked = selection.has(row.id) || implied;
          const isRoot = selection.has(row.id);
          const searching = visible !== null;
          const isOpen = searching || expanded.has(row.id);
          return (
            <li
              key={row.id}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={row.hasChildren ? isOpen : undefined}
              aria-selected={checked}
              className={cn("flex items-center gap-2 border-b border-border py-1.5 pr-3 last:border-b-0", checked && "bg-accent-soft/40")}
              style={{ paddingLeft: 8 + row.depth * 20 }}
            >
              {row.hasChildren && !searching ? (
                <button
                  type="button"
                  onClick={() => toggleExpanded(row.id)}
                  aria-label={isOpen ? t("notionMigration.pick.collapse") : t("notionMigration.pick.expand")}
                  className="grid h-5 w-5 flex-none place-items-center rounded text-text-3 hover:bg-surface-3 hover:text-text"
                >
                  {isOpen ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
                </button>
              ) : (
                <span className="h-5 w-5 flex-none" aria-hidden />
              )}
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 flex-none accent-accent"
                  checked={checked}
                  disabled={busy || implied}
                  onChange={() => onChange(toggleRoot(tree, selection, row.id, defaultTarget))}
                />
                <NodeIcon kind={node.kind} icon={node.icon} />
                <span className="min-w-0 truncate text-[14px] text-text">{node.title || "—"}</span>
                {node.kind === "database" && (
                  <span className="flex-none whitespace-nowrap text-[12.5px] text-text-3">
                    {t("notionMigration.pick.database")} · {t("notionMigration.pick.rowCount", { count: node.rowCount ?? 0 })}
                  </span>
                )}
              </label>
              {implied && !isRoot && <span className="flex-none whitespace-nowrap text-[12.5px] text-text-3">{t("notionMigration.pick.included")}</span>}
              {isRoot && (
                <TargetSelect
                  ariaLabel={`${t("notionMigration.pick.destinationLabel")}: ${node.title}`}
                  value={selection.get(row.id) ?? defaultTarget}
                  onChange={(target) => onChange(setRootDestination(selection, row.id, target))}
                  canImportToWorkspace={canImportToWorkspace}
                  teams={teams}
                  disabled={busy}
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button variant="ghost" onClick={onRescan} disabled={busy}>
          {t("notionMigration.pick.scanAgain")}
        </Button>
        <div className="flex items-center gap-3">
          {selection.size === 0 && <span className="text-[13px] text-text-3">{t("notionMigration.pick.nothingSelected")}</span>}
          <Button variant="primary" onClick={onReview} disabled={busy || selection.size === 0}>
            {t("notionMigration.pick.review")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function NodeIcon({ kind, icon }: { kind: "page" | "database" | "row"; icon: string | null }) {
  if (kind === "database") return <Table2 size={15} strokeWidth={1.75} className="flex-none text-text-3" aria-hidden />;
  if (icon) return <span className="flex-none text-[14px] leading-none" aria-hidden>{icon}</span>;
  return <span className="h-3.5 w-3.5 flex-none rounded-[3px] bg-surface-3" aria-hidden />;
}
