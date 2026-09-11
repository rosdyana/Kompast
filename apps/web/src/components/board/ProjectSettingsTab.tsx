import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Tabs } from "@kompast/ui/Tabs";
import { Badge } from "@kompast/ui/Badge";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { useConfirmArm } from "@/lib/use-confirm-arm";
import type { getProjectBoardFn } from "@/lib/server-fns/projects";
import {
  createBoardColumnFn,
  updateBoardColumnFn,
  deleteBoardColumnFn,
  reorderBoardColumnsFn,
  listWorkflowStatusesFn,
} from "@/lib/server-fns/board-columns";
import {
  listIssuePropertyDefinitionsFn,
  createIssuePropertyDefinitionFn,
  updateIssuePropertyDefinitionFn,
  deleteIssuePropertyDefinitionFn,
} from "@/lib/server-fns/issue-properties";
import { listPriorityLevelsFn, createPriorityLevelFn, updatePriorityLevelFn, deletePriorityLevelFn } from "@/lib/server-fns/priority";

type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;
type PropertyDefinition = Awaited<ReturnType<typeof listIssuePropertyDefinitionsFn>>[number];
type PriorityLevel = Awaited<ReturnType<typeof listPriorityLevelsFn>>[number];

/** Duplicated from packages/core/src/issue-property.ts — see server-fns/issue-properties.ts's own comment on why this list isn't imported. */
const ISSUE_PROPERTY_TYPES = ["text", "textarea", "number", "date", "checkbox", "select", "multiSelect", "url", "person"] as const;

const COLUMN_TONES = ["var(--indigo)", "var(--violet)", "var(--amber)", "var(--green)", "var(--danger)", "var(--text-3)"];

export function ProjectSettingsTab({ data }: { data: BoardData }) {
  const { t } = useTranslation("board");
  const [subTab, setSubTab] = useState<"columns" | "properties" | "priority">("columns");
  const subTabs = [
    { key: "columns", label: t("settingsTab.columnsHeading") },
    { key: "properties", label: t("settingsTab.propertiesHeading") },
    { key: "priority", label: t("settingsTab.priorityHeading") },
  ];

  return (
    <div className="p-6">
      <Tabs items={subTabs} active={subTab} onChange={(key) => setSubTab(key as typeof subTab)} className="mb-5" />
      {subTab === "columns" && <ColumnsSettings data={data} />}
      {subTab === "properties" && <PropertiesSettings projectId={data.project.id} />}
      {subTab === "priority" && <PrioritySettings projectId={data.project.id} />}
    </div>
  );
}

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

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold">{t("settingsTab.columnsHeading")}</h2>
      <p className="mb-4 type-body text-text-2">
        {t("settingsTab.columnsDescPart1")}
        <strong className="text-text">{t("settingsTab.columnsDescBold")}</strong>
        {t("settingsTab.columnsDescPart2")}
      </p>
      {error && <p className="mb-4 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>}
      {flowText && (
        <div className="mb-4 flex items-center gap-2 rounded-[10px] border border-dashed border-border-2 px-3 py-2.5 type-body text-text-2">
          <span className="type-label-overline text-text-3">{t("settingsTab.flowLabel")}</span>
          <span className="font-medium">{flowText}</span>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-2 px-3 py-2 type-body font-semibold text-text-2">
          {t("settingsTab.columnsCountSummary", { count: columns.length })}
        </div>
        {columns.map((col, i) => (
          <div key={col.id} className="flex flex-wrap items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0">
            <span className="flex min-w-[190px] flex-1 items-center gap-2">
              <span className="h-2 w-2 flex-none rounded-full" style={{ background: col.color }} />
              <input
                defaultValue={col.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== col.name && rename(col.id, e.target.value.trim())}
                className="min-w-0 flex-1 rounded-[7px] border border-transparent bg-transparent px-2 py-1 text-[12.5px] font-medium outline-none focus:border-border-2 focus:bg-surface"
              />
              <span className="type-label text-text-3">{col.issues.length}</span>
              {col.isBacklog && <Badge>{t("fixedBadge")}</Badge>}
            </span>
            <span className="flex items-center gap-1">
              {COLUMN_TONES.map((tone) => (
                <button
                  key={tone}
                  onClick={() => recolor(col.id, tone)}
                  title={tone}
                  className="h-[15px] w-[15px] flex-none rounded-full"
                  style={{ background: tone, boxShadow: col.color === tone ? "0 0 0 2px var(--border-2)" : undefined }}
                />
              ))}
            </span>
            <input
              defaultValue={col.wipLimit ?? ""}
              placeholder="∞"
              onBlur={(e) => setWip(col.id, e.target.value)}
              className="w-[52px] rounded-[7px] border border-border-2 bg-surface px-2 py-1 font-mono text-[12.5px] outline-none"
            />
            {!col.isBacklog && (
              <span className="flex gap-0.5">
                <button
                  onClick={() => move(col.id, "left")}
                  disabled={i <= 1}
                  title={t("settingsTab.moveLeftTitle")}
                  className="rounded-[7px] px-1.5 py-0.5 text-text-3 hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronLeft size={13} strokeWidth={1.75} />
                </button>
                <button
                  onClick={() => move(col.id, "right")}
                  disabled={i === columns.length - 1}
                  title={t("settingsTab.moveRightTitle")}
                  className="rounded-[7px] px-1.5 py-0.5 text-text-3 hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronRight size={13} strokeWidth={1.75} />
                </button>
                <button
                  onClick={() => handleDeleteClick(col.id)}
                  title={isArmed(col.id) ? t("settingsTab.deleteColumnConfirm") : t("settingsTab.deleteColumnTitle")}
                  className="rounded-[7px] px-1.5 py-0.5 text-[11px] hover:bg-danger-soft hover:text-danger"
                  style={isArmed(col.id) ? { color: "var(--danger)", background: "var(--danger-soft)" } : undefined}
                >
                  {isArmed(col.id) ? t("clickAgainToDelete") : <X size={13} strokeWidth={1.75} />}
                </button>
              </span>
            )}
          </div>
        ))}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <input
            value={newColName}
            onChange={(e) => setNewColName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addColumn()}
            placeholder={t("settingsTab.newColumnPlaceholder")}
            className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
          />
          <Button variant="outline" onClick={addColumn} disabled={creating || !newColName.trim()}>
            {t("settingsTab.addColumnButton")}
          </Button>
        </div>
      </div>
      <p className="mt-3 type-body text-text-3">{t("settingsTab.columnsFooterNote")}</p>
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
    <div>
      <h2 className="mb-1 text-lg font-semibold">{t("settingsTab.propertiesHeading")}</h2>
      <p className="mb-4 type-body text-text-2">
        {t("settingsTab.propertiesDescPart1")}
        <strong className="text-text">{t("settingsTab.propertiesDescBold", { count: visCount })}</strong>
      </p>
      {error && <p className="mb-4 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-2 px-3 py-2 type-body font-semibold text-text-2">
          {t("settingsTab.propertiesCountSummary", { visible: visCount, total: definitions.length })}
        </div>
        {definitions.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0">
            <span className="flex min-w-[190px] flex-1 items-center gap-1.5">
              <input
                defaultValue={p.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && rename(p.id, e.target.value.trim())}
                className="min-w-0 flex-1 rounded-[7px] border border-transparent bg-transparent px-2 py-1 text-[12.5px] font-medium outline-none focus:border-border-2 focus:bg-surface"
              />
              {p.isCore && <Badge>{t("settingsTab.coreBadge")}</Badge>}
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-text-3">
              {t("settingsTab.typeLabel")}
              <select
                value={p.type}
                onChange={(e) => retype(p.id, e.target.value as (typeof ISSUE_PROPERTY_TYPES)[number])}
                className="kp-select rounded-[7px] border border-border-2 bg-surface px-2 py-1 text-[12.5px] outline-none"
              >
                {ISSUE_PROPERTY_TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {ty}
                  </option>
                ))}
              </select>
            </span>
            <label className="flex items-center gap-1.5 text-[10px] text-text-3">
              {t("settingsTab.onCardLabel")}
              <input type="checkbox" checked={p.visibleOnCard} onChange={(e) => toggleVisible(p.id, e.target.checked)} />
            </label>
            {!p.isCore && (
              <button
                onClick={() => handleDeleteClick(p.id)}
                title={isArmed(p.id) ? t("settingsTab.deletePropertyConfirm") : t("settingsTab.deletePropertyTitle")}
                className="rounded-[7px] px-1.5 py-0.5 text-[11px] hover:bg-danger-soft hover:text-danger"
                style={isArmed(p.id) ? { color: "var(--danger)", background: "var(--danger-soft)" } : undefined}
              >
                {isArmed(p.id) ? t("clickAgainToDelete") : <X size={13} strokeWidth={1.75} />}
              </button>
            )}
          </div>
        ))}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addProperty()}
            placeholder={t("settingsTab.newPropertyPlaceholder")}
            className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as (typeof ISSUE_PROPERTY_TYPES)[number])}
            className="kp-select rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
          >
            {ISSUE_PROPERTY_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {ty}
              </option>
            ))}
          </select>
          <Button variant="outline" onClick={addProperty} disabled={creating || !newName.trim()}>
            {t("settingsTab.addPropertyButton")}
          </Button>
        </div>
      </div>
      <p className="mt-3 type-body text-text-3">{t("settingsTab.propertiesFooterNote")}</p>
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
    const i = levels.findIndex((l) => l.id === levelId);
    const j = direction === "left" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= levels.length) return;
    const a = levels[i]!;
    const b = levels[j]!;
    setError(null);
    try {
      await Promise.all([
        updatePriorityLevelFn({ data: { projectId, levelId: a.id, order: b.order } }),
        updatePriorityLevelFn({ data: { projectId, levelId: b.id, order: a.order } }),
      ]);
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
    <div>
      <h2 className="mb-1 text-lg font-semibold">{t("settingsTab.priorityHeading")}</h2>
      <p className="mb-4 type-body text-text-2">{t("settingsTab.priorityDesc")}</p>
      {error && <p className="mb-4 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>}
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-2 px-3 py-2 type-body font-semibold text-text-2">
          {t("settingsTab.priorityCountSummary", { count: levels.length })}
        </div>
        {levels.map((level, i) => (
          <div key={level.id} className="flex flex-wrap items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0">
            <span className="flex min-w-[190px] flex-1 items-center gap-2">
              <span className="h-2 w-2 flex-none rounded-full" style={{ background: level.color }} />
              <input
                defaultValue={level.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== level.name && rename(level.id, e.target.value.trim())}
                className="min-w-0 flex-1 rounded-[7px] border border-transparent bg-transparent px-2 py-1 text-[12.5px] font-medium outline-none focus:border-border-2 focus:bg-surface"
              />
            </span>
            <span className="flex items-center gap-1">
              {COLUMN_TONES.map((tone) => (
                <button
                  key={tone}
                  onClick={() => recolor(level.id, tone)}
                  title={tone}
                  className="h-[15px] w-[15px] flex-none rounded-full"
                  style={{ background: tone, boxShadow: level.color === tone ? "0 0 0 2px var(--border-2)" : undefined }}
                />
              ))}
            </span>
            <span className="flex gap-0.5">
              <button
                onClick={() => move(level.id, "left")}
                disabled={i === 0}
                title={t("settingsTab.moveLeftTitle")}
                className="rounded-[7px] px-1.5 py-0.5 text-text-3 hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronLeft size={13} strokeWidth={1.75} />
              </button>
              <button
                onClick={() => move(level.id, "right")}
                disabled={i === levels.length - 1}
                title={t("settingsTab.moveRightTitle")}
                className="rounded-[7px] px-1.5 py-0.5 text-text-3 hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronRight size={13} strokeWidth={1.75} />
              </button>
              <button
                onClick={() => handleDeleteClick(level.id)}
                title={isArmed(level.id) ? t("clickAgainToDelete") : undefined}
                className="rounded-[7px] px-1.5 py-0.5 text-[11px] hover:bg-danger-soft hover:text-danger"
                style={isArmed(level.id) ? { color: "var(--danger)", background: "var(--danger-soft)" } : undefined}
              >
                {isArmed(level.id) ? t("clickAgainToDelete") : <X size={13} strokeWidth={1.75} />}
              </button>
            </span>
          </div>
        ))}
        <div className="flex items-center gap-2 px-3 py-2.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLevel()}
            placeholder={t("settingsTab.newPriorityPlaceholder")}
            className="min-w-0 flex-1 rounded-[7px] border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
          />
          <Button variant="outline" onClick={addLevel} disabled={creating || !newName.trim()}>
            {t("settingsTab.addPriorityButton")}
          </Button>
        </div>
      </div>
    </div>
  );
}
