import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ArrowRight, ChevronDown, ChevronUp, Columns3, Flag, GripVertical, ListTree, Lock, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, CountPill } from "@kompast/ui/Badge";
import { Button } from "@kompast/ui/Button";
import { Card, CardHeader } from "@kompast/ui/Card";
import { StatusDot } from "@kompast/ui/Lozenge";
import { PriorityIcon } from "@kompast/ui/PriorityIcon";
import { cn } from "@/lib/cn";
import { useTranslation } from "@kompast/i18n";
import { useConfirmArm } from "@/lib/use-confirm-arm";
import type { getProjectBoardFn } from "@/lib/server-fns/projects";
import {
  createBoardColumnFn,
  updateBoardColumnFn,
  deleteBoardColumnFn,
  reorderBoardColumnsFn,
  listWorkflowStatusesFn,
  updateBoardSettingsFn,
} from "@/lib/server-fns/board-columns";
import {
  listIssuePropertyDefinitionsFn,
  createIssuePropertyDefinitionFn,
  updateIssuePropertyDefinitionFn,
  deleteIssuePropertyDefinitionFn,
  reorderIssuePropertyDefinitionsFn,
} from "@/lib/server-fns/issue-properties";
import {
  listPriorityLevelsFn,
  createPriorityLevelFn,
  updatePriorityLevelFn,
  deletePriorityLevelFn,
  reorderPriorityLevelsFn,
} from "@/lib/server-fns/priority";
import { ColorSwatchPicker, COLUMN_TONES } from "@/components/board/ColorSwatchPicker";
import { parseStandupSettings } from "@/components/board/standup-settings";

type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;
type PropertyDefinition = Awaited<ReturnType<typeof listIssuePropertyDefinitionsFn>>[number];
type PriorityLevel = Awaited<ReturnType<typeof listPriorityLevelsFn>>[number];

/** Duplicated from packages/core/src/issue-property.ts — see server-fns/issue-properties.ts's own comment on why this list isn't imported. */
const ISSUE_PROPERTY_TYPES = ["text", "textarea", "number", "date", "checkbox", "select", "multiSelect", "url", "person"] as const;

type SubTab = "columns" | "properties" | "priority";

export function ProjectSettingsTab({ data }: { data: BoardData }) {
  const { t } = useTranslation("board");
  const [subTab, setSubTab] = useState<SubTab>("columns");
  const subTabs: { key: SubTab; label: string; icon: ReactNode }[] = [
    { key: "columns", label: t("settingsTab.columnsHeading"), icon: <Columns3 size={16} strokeWidth={1.75} /> },
    { key: "properties", label: t("settingsTab.propertiesHeading"), icon: <ListTree size={16} strokeWidth={1.75} /> },
    { key: "priority", label: t("settingsTab.priorityHeading"), icon: <Flag size={16} strokeWidth={1.75} /> },
  ];

  return (
    <div className="kp-settings mx-auto grid w-full px-4 pb-10 md:px-0 max-w-[1120px] grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
      <nav aria-label={t("settingsTab.navLabel")} className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {subTabs.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-current={subTab === item.key ? "page" : undefined}
            onClick={() => setSubTab(item.key)}
            className={cn(
              "flex h-8 flex-none items-center gap-2 whitespace-nowrap rounded-[6px] px-2.5 text-left text-[14px] transition-colors",
              subTab === item.key ? "bg-accent-soft font-medium text-accent-text" : "text-text-2 hover:bg-surface-3 hover:text-text",
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0">
        {subTab === "columns" && <ColumnsSettings data={data} />}
        {subTab === "properties" && <PropertiesSettings projectId={data.project.id} />}
        {subTab === "priority" && <PrioritySettings projectId={data.project.id} />}
      </div>
    </div>
  );
}

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>;
}

function SectionIntro({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="type-title text-[20px]">{title}</h2>
      <p className="mt-1 max-w-[680px] type-body text-text-2">{children}</p>
    </div>
  );
}

/** Up/down reorder pair — the list is vertical, so direction reads as up/down. */
function ReorderButtons({ onUp, onDown, upDisabled, downDisabled }: { onUp: () => void; onDown: () => void; upDisabled: boolean; downDisabled: boolean }) {
  const { t } = useTranslation("board");
  const btn = "grid h-7 w-7 place-items-center rounded-[5px] text-text-3 hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-30";
  return (
    <span className="flex flex-none items-center">
      <button type="button" onClick={onUp} disabled={upDisabled} aria-label={t("settingsTab.moveUpTitle")} title={t("settingsTab.moveUpTitle")} className={btn}>
        <ChevronUp size={15} strokeWidth={2} />
      </button>
      <button type="button" onClick={onDown} disabled={downDisabled} aria-label={t("settingsTab.moveDownTitle")} title={t("settingsTab.moveDownTitle")} className={btn}>
        <ChevronDown size={15} strokeWidth={2} />
      </button>
    </span>
  );
}

function DeleteButton({ armed, onClick, title }: { armed: boolean; onClick: () => void; title: string }) {
  const { t } = useTranslation("board");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={armed ? t("settingsTab.confirmDelete") : title}
      title={armed ? t("clickAgainToDelete") : title}
      className={cn(
        "inline-flex h-7 flex-none items-center gap-1 rounded-[5px] px-1.5 text-[12.5px] font-medium transition-colors",
        armed ? "bg-danger text-white" : "text-text-3 hover:bg-danger-soft hover:text-danger",
      )}
    >
      <Trash2 size={14} strokeWidth={1.75} />
      {armed && t("settingsTab.confirmDelete")}
    </button>
  );
}

const rowCls = "group/row flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surface-2";
const nameInputCls = "kp-quiet h-8 min-w-0 flex-1 text-[14px] font-medium disabled:opacity-60";
const addRowCls = "flex flex-wrap items-center gap-2 border-t border-border bg-surface-2 px-3 py-2.5";

function ColumnsSettings({ data }: { data: BoardData }) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const [flowText, setFlowText] = useState<string | null>(null);
  const [newColName, setNewColName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isArmed, arm, disarm } = useConfirmArm();

  useEffect(() => {
    listWorkflowStatusesFn({ data: data.project.id }).then((statuses) => setFlowText(statuses.map((s) => s.name).join(" → ")));
  }, [data.project.id]);

  const columns = [...data.columns].sort((a, b) => a.order - b.order);

  async function addColumn() {
    if (!newColName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createBoardColumnFn({ data: { projectId: data.project.id, boardId: data.board.id, name: newColName.trim() } });
      setNewColName("");
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setCreating(false);
    }
  }

  async function rename(columnId: string, name: string) {
    setError(null);
    try {
      await updateBoardColumnFn({ data: { projectId: data.project.id, columnId, name } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function recolor(columnId: string, color: string) {
    setError(null);
    try {
      await updateBoardColumnFn({ data: { projectId: data.project.id, columnId, color } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function setWip(columnId: string, raw: string) {
    const wipLimit = raw.trim() === "" ? null : Number(raw);
    setError(null);
    try {
      await updateBoardColumnFn({ data: { projectId: data.project.id, columnId, wipLimit } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function setStuck(columnId: string, raw: string) {
    const stuckAfterDays = raw.trim() === "" ? null : Number(raw);
    setError(null);
    try {
      await updateBoardColumnFn({ data: { projectId: data.project.id, columnId, stuckAfterDays } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function setNewIssuePosition(position: "top" | "bottom") {
    setError(null);
    try {
      await updateBoardSettingsFn({ data: { projectId: data.project.id, boardId: data.board.id, newIssuePosition: position } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function setSwimlaneMaxCards(input: HTMLInputElement) {
    const n = Number(input.value);
    if (n === data.board.swimlaneMaxCards) return;
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      // Out of range or blank: snap back to the saved value rather than saving something odd.
      input.value = String(data.board.swimlaneMaxCards);
      return;
    }
    setError(null);
    try {
      await updateBoardSettingsFn({ data: { projectId: data.project.id, boardId: data.board.id, swimlaneMaxCards: n } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function move(columnId: string, direction: "left" | "right") {
    const ids = columns.map((c) => c.id);
    const i = ids.indexOf(columnId);
    const j = direction === "left" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setError(null);
    try {
      await reorderBoardColumnsFn({ data: { projectId: data.project.id, boardId: data.board.id, orderedColumnIds: ids } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function remove(columnId: string) {
    setError(null);
    try {
      await deleteBoardColumnFn({ data: { projectId: data.project.id, columnId } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  function handleDeleteClick(columnId: string) {
    if (!isArmed(columnId)) {
      arm(columnId);
      return;
    }
    disarm();
    remove(columnId);
  }

  // Stored ids of deleted columns are dropped here, so every save writes only ids that still exist.
  const standup = parseStandupSettings(data.board.standupSettings);
  const existingColumnIds = new Set(columns.map((c) => c.id));
  const checkedDidIds = standup.didColumnIds.filter((id) => existingColumnIds.has(id));
  const checkedTodayIds = standup.todayColumnIds.filter((id) => existingColumnIds.has(id));

  async function saveStandupColumns(patch: { standupDidColumnIds: string[] } | { standupTodayColumnIds: string[] }) {
    setError(null);
    try {
      await updateBoardSettingsFn({ data: { projectId: data.project.id, boardId: data.board.id, ...patch } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  /** Board order is kept regardless of click order. */
  function nextChecked(current: string[], columnId: string, on: boolean): string[] {
    const set = new Set(current);
    if (on) set.add(columnId);
    else set.delete(columnId);
    return columns.map((c) => c.id).filter((id) => set.has(id));
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title={t("settingsTab.columnsHeading")}>
        {t("settingsTab.columnsDescPart1")}
        <strong className="font-medium text-text">{t("settingsTab.columnsDescBold")}</strong>
        {t("settingsTab.columnsDescPart2")}
      </SectionIntro>
      <ErrorNote error={error} />

      <Card>
        <CardHeader title={t("settingsTab.workflowTitle")} description={t("settingsTab.columnsCountSummary", { count: columns.length })} />
        {flowText && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2.5 text-[13px] text-text-2">
            {flowText.split(" → ").map((name, i) => (
              <span key={`${name}-${i}`} className="inline-flex items-center gap-1.5">
                {i > 0 && <ArrowRight size={12} className="text-text-3" />}
                <span className="rounded-[4px] bg-surface-3 px-1.5 py-0.5 font-medium">{name}</span>
              </span>
            ))}
          </div>
        )}
        <div>
          {columns.map((col, i) => (
            <div key={col.id} className={rowCls}>
              <span className="grid w-5 flex-none place-items-center text-text-3">
                {col.isBacklog ? <Lock size={13} strokeWidth={1.75} /> : <GripVertical size={14} strokeWidth={1.75} className="opacity-40" />}
              </span>
              <StatusDot color={col.color} size={10} />
              <input
                key={`${col.id}-${col.name}`}
                defaultValue={col.name}
                aria-label={t("settingsTab.nameLabel")}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== col.name && rename(col.id, e.target.value.trim())}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                className={cn(nameInputCls, "min-w-[140px]")}
              />
              <span className="flex-none text-[12.5px] tabular-nums text-text-3">{t("settingsTab.issuesCount", { count: col.issues.length })}</span>
              {col.isBacklog && <Badge>{t("fixedBadge")}</Badge>}
              <ColorSwatchPicker value={col.color} onChange={(color) => recolor(col.id, color)} label={t("settingsTab.colorLabel")} />
              <label className="flex flex-none items-center gap-1.5 text-[12.5px] text-text-3" title={t("settingsTab.wipHint")}>
                {t("settingsTab.wipLabel")}
                <input
                  key={`${col.id}-wip-${col.wipLimit ?? ""}`}
                  defaultValue={col.wipLimit ?? ""}
                  inputMode="numeric"
                  placeholder="∞"
                  onBlur={(e) => e.target.value !== String(col.wipLimit ?? "") && setWip(col.id, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  className="kp-field h-7 w-[56px] text-center tabular-nums"
                />
              </label>
              <label className="flex flex-none items-center gap-1.5 text-[12.5px] text-text-3" title={t("settingsTab.stuckHint")}>
                {t("settingsTab.stuckLabel")}
                <input
                  key={`${col.id}-stuck-${col.stuckAfterDays ?? ""}`}
                  defaultValue={col.stuckAfterDays ?? ""}
                  inputMode="numeric"
                  placeholder="∞"
                  onBlur={(e) => e.target.value !== String(col.stuckAfterDays ?? "") && setStuck(col.id, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  className="kp-field h-7 w-[56px] text-center tabular-nums"
                />
              </label>
              {col.isBacklog ? (
                <span className="w-[92px] flex-none" />
              ) : (
                <>
                  <ReorderButtons onUp={() => move(col.id, "left")} onDown={() => move(col.id, "right")} upDisabled={i <= 1} downDisabled={i === columns.length - 1} />
                  <DeleteButton armed={isArmed(col.id)} onClick={() => handleDeleteClick(col.id)} title={t("settingsTab.deleteColumnTitle")} />
                </>
              )}
            </div>
          ))}
        </div>
        <div className={addRowCls}>
          <input
            value={newColName}
            onChange={(e) => setNewColName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addColumn()}
            placeholder={t("settingsTab.newColumnPlaceholder")}
            aria-label={t("settingsTab.newColumnPlaceholder")}
            className="kp-input h-8 min-w-[180px] flex-1"
          />
          <Button variant="outline" onClick={addColumn} disabled={creating || !newColName.trim()}>
            <Plus size={15} strokeWidth={2} />
            {t("settingsTab.addColumnButton")}
          </Button>
        </div>
      </Card>
      <p className="text-[13px] text-text-3">{t("settingsTab.columnsFooterNote")}</p>

      <Card>
        <CardHeader
          title={t("settingsTab.boardBehavior")}
          description={t("settingsTab.boardBehaviorDesc")}
          actions={
            <select
              value={data.board.newIssuePosition}
              onChange={(e) => setNewIssuePosition(e.target.value as "top" | "bottom")}
              aria-label={t("settingsTab.newIssuePositionLabel")}
              className="kp-field kp-select h-8"
            >
              <option value="top">{t("settingsTab.newIssuePositionTop")}</option>
              <option value="bottom">{t("settingsTab.newIssuePositionBottom")}</option>
            </select>
          }
        />
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium text-text">{t("settingsTab.swimlaneMaxCardsLabel")}</p>
            <p className="type-small text-text-3">{t("settingsTab.swimlaneMaxCardsHint")}</p>
          </div>
          <input
            key={`swimlane-max-${data.board.swimlaneMaxCards}`}
            defaultValue={data.board.swimlaneMaxCards}
            type="number"
            min={1}
            max={50}
            inputMode="numeric"
            aria-label={t("settingsTab.swimlaneMaxCardsLabel")}
            onBlur={(e) => setSwimlaneMaxCards(e.target)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="kp-field h-8 w-[72px] flex-none text-center tabular-nums"
          />
        </div>
      </Card>

      <Card>
        <CardHeader title={t("settingsTab.standupTitle")} description={t("settingsTab.standupDesc")} />
        <StandupColumnPicker
          label={t("settingsTab.standupDidLabel")}
          hint={t("settingsTab.standupDidHint")}
          columns={columns}
          checkedIds={checkedDidIds}
          onToggle={(columnId, on) => saveStandupColumns({ standupDidColumnIds: nextChecked(checkedDidIds, columnId, on) })}
        />
        <StandupColumnPicker
          label={t("settingsTab.standupTodayLabel")}
          hint={t("settingsTab.standupTodayHint")}
          columns={columns}
          checkedIds={checkedTodayIds}
          onToggle={(columnId, on) => saveStandupColumns({ standupTodayColumnIds: nextChecked(checkedTodayIds, columnId, on) })}
        />
      </Card>
    </div>
  );
}

function StandupColumnPicker({
  label,
  hint,
  columns,
  checkedIds,
  onToggle,
}: {
  label: string;
  hint: string;
  columns: { id: string; name: string; color: string }[];
  checkedIds: string[];
  onToggle: (columnId: string, on: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <div>
        <p className="text-[13.5px] font-medium text-text">{label}</p>
        <p className="type-small text-text-3">{hint}</p>
      </div>
      <div className="flex flex-col gap-0.5">
        {columns.map((col) => (
          <label key={col.id} className="flex items-center gap-2 rounded-[4px] px-1 py-0.5 text-[13.5px] text-text-2 hover:bg-surface-2">
            <input type="checkbox" checked={checkedIds.includes(col.id)} onChange={(e) => onToggle(col.id, e.target.checked)} />
            <StatusDot color={col.color} size={10} />
            {col.name}
          </label>
        ))}
      </div>
    </div>
  );
}

function PropertiesSettings({ projectId }: { projectId: string }) {
  const { t } = useTranslation("board");
  const [definitions, setDefinitions] = useState<PropertyDefinition[] | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<(typeof ISSUE_PROPERTY_TYPES)[number]>("text");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isArmed, arm, disarm } = useConfirmArm();

  async function refresh() {
    setDefinitions(await listIssuePropertyDefinitionsFn({ data: projectId }));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function addProperty() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createIssuePropertyDefinitionFn({ data: { projectId, name: newName.trim(), type: newType } });
      setNewName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setCreating(false);
    }
  }

  async function rename(definitionId: string, name: string) {
    setError(null);
    try {
      await updateIssuePropertyDefinitionFn({ data: { projectId, definitionId, name } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function retype(definitionId: string, type: (typeof ISSUE_PROPERTY_TYPES)[number]) {
    setError(null);
    try {
      await updateIssuePropertyDefinitionFn({ data: { projectId, definitionId, type } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function toggleVisible(definitionId: string, visibleOnCard: boolean) {
    setError(null);
    try {
      await updateIssuePropertyDefinitionFn({ data: { projectId, definitionId, visibleOnCard } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function move(definitionId: string, direction: "left" | "right") {
    if (!definitions) return;
    const ids = definitions.map((d) => d.id);
    const i = ids.indexOf(definitionId);
    const j = direction === "left" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setError(null);
    try {
      await reorderIssuePropertyDefinitionsFn({ data: { projectId, orderedDefinitionIds: ids } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function remove(definitionId: string) {
    setError(null);
    try {
      await deleteIssuePropertyDefinitionFn({ data: { projectId, definitionId } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  function handleDeleteClick(definitionId: string) {
    if (!isArmed(definitionId)) {
      arm(definitionId);
      return;
    }
    disarm();
    remove(definitionId);
  }

  if (!definitions) return null;
  const visCount = definitions.filter((d) => d.visibleOnCard).length;

  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title={t("settingsTab.propertiesHeading")}>
        {t("settingsTab.propertiesDescPart1")}
        <strong className="font-medium text-text">{t("settingsTab.propertiesDescBold", { count: visCount })}</strong>
      </SectionIntro>
      <ErrorNote error={error} />
      <Card>
        <CardHeader title={t("settingsTab.propertiesHeading")} description={t("settingsTab.propertiesCountSummary", { visible: visCount, total: definitions.length })} />
        <div>
          {definitions.map((p, i) => (
            <div key={p.id} className={rowCls}>
              <input
                key={`${p.id}-${p.name}`}
                defaultValue={p.name}
                disabled={p.isCore}
                aria-label={t("settingsTab.nameLabel")}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== p.name && rename(p.id, e.target.value.trim())}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                className={cn(nameInputCls, "min-w-[160px]")}
              />
              {p.isCore && <Badge>{t("settingsTab.coreBadge")}</Badge>}
              <label className="flex flex-none items-center gap-1.5 text-[12.5px] text-text-3">
                {t("settingsTab.typeLabel")}
                <select
                  value={p.type}
                  disabled={p.isCore}
                  onChange={(e) => retype(p.id, e.target.value as (typeof ISSUE_PROPERTY_TYPES)[number])}
                  className="kp-field kp-select h-7 w-[140px] disabled:opacity-60"
                >
                  {ISSUE_PROPERTY_TYPES.map((ty) => (
                    <option key={ty} value={ty}>
                      {t(`settingsTab.propType_${ty}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={cn("flex flex-none items-center gap-1.5 text-[12.5px] text-text-3", p.isCore && "opacity-60")}>
                <input type="checkbox" checked={p.visibleOnCard} disabled={p.isCore} onChange={(e) => toggleVisible(p.id, e.target.checked)} />
                {t("settingsTab.onCardLabel")}
              </label>
              <ReorderButtons onUp={() => move(p.id, "left")} onDown={() => move(p.id, "right")} upDisabled={i === 0} downDisabled={i === definitions.length - 1} />
              {p.isCore ? (
                <span className="w-7 flex-none" />
              ) : (
                <DeleteButton armed={isArmed(p.id)} onClick={() => handleDeleteClick(p.id)} title={t("settingsTab.deletePropertyTitle")} />
              )}
            </div>
          ))}
        </div>
        <div className={addRowCls}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addProperty()}
            placeholder={t("settingsTab.newPropertyPlaceholder")}
            aria-label={t("settingsTab.newPropertyPlaceholder")}
            className="kp-input h-8 min-w-[180px] flex-1"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as (typeof ISSUE_PROPERTY_TYPES)[number])}
            aria-label={t("settingsTab.typeLabel")}
            className="kp-input kp-select h-8 w-[150px]"
          >
            {ISSUE_PROPERTY_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`settingsTab.propType_${ty}`)}
              </option>
            ))}
          </select>
          <Button variant="outline" onClick={addProperty} disabled={creating || !newName.trim()}>
            <Plus size={15} strokeWidth={2} />
            {t("settingsTab.addPropertyButton")}
          </Button>
        </div>
      </Card>
      <p className="text-[13px] text-text-3">{t("settingsTab.propertiesFooterNote")}</p>
    </div>
  );
}

function PrioritySettings({ projectId }: { projectId: string }) {
  const { t } = useTranslation("board");
  const [levels, setLevels] = useState<PriorityLevel[] | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isArmed, arm, disarm } = useConfirmArm();

  async function refresh() {
    setLevels(await listPriorityLevelsFn({ data: projectId }));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function addLevel() {
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createPriorityLevelFn({ data: { projectId, name: newName.trim(), color: COLUMN_TONES[0]! } });
      setNewName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setCreating(false);
    }
  }

  async function rename(levelId: string, name: string) {
    setError(null);
    try {
      await updatePriorityLevelFn({ data: { projectId, levelId, name } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function recolor(levelId: string, color: string) {
    setError(null);
    try {
      await updatePriorityLevelFn({ data: { projectId, levelId, color } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function move(levelId: string, direction: "left" | "right") {
    if (!levels) return;
    const ids = levels.map((l) => l.id);
    const i = ids.indexOf(levelId);
    const j = direction === "left" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setError(null);
    try {
      await reorderPriorityLevelsFn({ data: { projectId, orderedLevelIds: ids } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  async function remove(levelId: string) {
    setError(null);
    try {
      await deletePriorityLevelFn({ data: { projectId, levelId } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    }
  }

  function handleDeleteClick(levelId: string) {
    if (!isArmed(levelId)) {
      arm(levelId);
      return;
    }
    disarm();
    remove(levelId);
  }

  if (!levels) return null;

  return (
    <div className="flex flex-col gap-4">
      <SectionIntro title={t("settingsTab.priorityHeading")}>{t("settingsTab.priorityDesc")}</SectionIntro>
      <ErrorNote error={error} />
      <Card>
        <CardHeader title={t("settingsTab.priorityHeading")} actions={<CountPill>{levels.length}</CountPill>} />
        <div>
          {levels.map((level, i) => (
            <div key={level.id} className={rowCls}>
              <span className="grid w-5 flex-none place-items-center">
                <PriorityIcon priority={level} />
              </span>
              <input
                key={`${level.id}-${level.name}`}
                defaultValue={level.name}
                aria-label={t("settingsTab.nameLabel")}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== level.name && rename(level.id, e.target.value.trim())}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                className={cn(nameInputCls, "min-w-[160px]")}
              />
              <span className="type-key flex-none text-text-3">{level.key}</span>
              <ColorSwatchPicker value={level.color} onChange={(color) => recolor(level.id, color)} label={t("settingsTab.colorLabel")} />
              <ReorderButtons onUp={() => move(level.id, "left")} onDown={() => move(level.id, "right")} upDisabled={i === 0} downDisabled={i === levels.length - 1} />
              <DeleteButton armed={isArmed(level.id)} onClick={() => handleDeleteClick(level.id)} title={t("settingsTab.deleteLevelTitle")} />
            </div>
          ))}
        </div>
        <div className={addRowCls}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLevel()}
            placeholder={t("settingsTab.newPriorityPlaceholder")}
            aria-label={t("settingsTab.newPriorityPlaceholder")}
            className="kp-input h-8 min-w-[180px] flex-1"
          />
          <Button variant="outline" onClick={addLevel} disabled={creating || !newName.trim()}>
            <Plus size={15} strokeWidth={2} />
            {t("settingsTab.addPriorityButton")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
