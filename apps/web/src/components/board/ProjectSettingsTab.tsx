import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Tabs } from "@kompast/ui/Tabs";
import { Badge } from "@kompast/ui/Badge";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
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

type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;
type PropertyDefinition = Awaited<ReturnType<typeof listIssuePropertyDefinitionsFn>>[number];

/** Duplicated from packages/core/src/issue-property.ts — see server-fns/issue-properties.ts's own comment on why this list isn't imported. */
const ISSUE_PROPERTY_TYPES = ["text", "textarea", "number", "date", "checkbox", "select", "multiSelect", "url", "person"] as const;

const COLUMN_TONES = ["var(--indigo)", "var(--violet)", "var(--amber)", "var(--green)", "var(--danger)", "var(--text-3)"];

export function ProjectSettingsTab({ data }: { data: BoardData }) {
  const { t } = useTranslation("board");
  const [subTab, setSubTab] = useState<"columns" | "properties">("columns");
  const subTabs = [
    { key: "columns", label: t("settingsTab.columnsHeading") },
    { key: "properties", label: t("settingsTab.propertiesHeading") },
  ];

  return (
    <div className="p-6">
      <Tabs items={subTabs} active={subTab} onChange={(key) => setSubTab(key as typeof subTab)} className="mb-5" />
      {subTab === "columns" && <ColumnsSettings data={data} />}
      {subTab === "properties" && <PropertiesSettings projectId={data.project.id} />}
    </div>
  );
}

function ColumnsSettings({ data }: { data: BoardData }) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const [flowText, setFlowText] = useState<string | null>(null);
  const [newColName, setNewColName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listWorkflowStatusesFn({ data: data.project.id }).then((statuses) => setFlowText(statuses.map((s) => s.name).join(" → ")));
  }, [data.project.id]);

  const columns = [...data.columns].sort((a, b) => a.order - b.order);

  async function addColumn() {
    if (!newColName.trim()) return;
    setCreating(true);
    try {
      await createBoardColumnFn({ data: { projectId: data.project.id, boardId: data.board.id, name: newColName.trim() } });
      setNewColName("");
      await router.invalidate();
    } finally {
      setCreating(false);
    }
  }

  async function rename(columnId: string, name: string) {
    await updateBoardColumnFn({ data: { projectId: data.project.id, columnId, name } });
    await router.invalidate();
  }

  async function recolor(columnId: string, color: string) {
    await updateBoardColumnFn({ data: { projectId: data.project.id, columnId, color } });
    await router.invalidate();
  }

  async function setWip(columnId: string, raw: string) {
    const wipLimit = raw.trim() === "" ? null : Number(raw);
    await updateBoardColumnFn({ data: { projectId: data.project.id, columnId, wipLimit } });
    await router.invalidate();
  }

  async function move(columnId: string, direction: "left" | "right") {
    const ids = columns.map((c) => c.id);
    const i = ids.indexOf(columnId);
    const j = direction === "left" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    await reorderBoardColumnsFn({ data: { projectId: data.project.id, boardId: data.board.id, orderedColumnIds: ids } });
    await router.invalidate();
  }

  async function remove(columnId: string) {
    if (!window.confirm(t("settingsTab.deleteColumnConfirm"))) return;
    await deleteBoardColumnFn({ data: { projectId: data.project.id, columnId } });
    await router.invalidate();
  }

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold">{t("settingsTab.columnsHeading")}</h2>
      <p className="mb-4 text-[13px] text-text-2">
        {t("settingsTab.columnsDescPart1")}
        <strong className="text-text">{t("settingsTab.columnsDescBold")}</strong>
        {t("settingsTab.columnsDescPart2")}
      </p>
      {flowText && (
        <div className="mb-4 flex items-center gap-2 rounded-[11px] border border-dashed border-border-2 px-3.5 py-2.5 text-[12.5px] text-text-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-3">{t("settingsTab.flowLabel")}</span>
          <span className="font-medium">{flowText}</span>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-2 px-3.5 py-2 text-[11px] font-semibold text-text-2">
          {t("settingsTab.columnsCountSummary", { count: columns.length })}
        </div>
        {columns.map((col, i) => (
          <div key={col.id} className="flex flex-wrap items-center gap-2.5 border-b border-border px-3.5 py-2 last:border-b-0">
            <span className="flex min-w-[190px] flex-1 items-center gap-2">
              <span className="h-2 w-2 flex-none rounded-full" style={{ background: col.color }} />
              <input
                defaultValue={col.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== col.name && rename(col.id, e.target.value.trim())}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[12.5px] font-medium outline-none focus:border-border-2 focus:bg-surface"
              />
              <span className="font-mono text-[10px] text-text-3">{col.issues.length}</span>
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
              className="w-[52px] rounded-md border border-border-2 bg-surface px-2 py-1 font-mono text-[12px] outline-none"
            />
            {!col.isBacklog && (
              <span className="flex gap-0.5">
                <button
                  onClick={() => move(col.id, "left")}
                  disabled={i <= 1}
                  title={t("settingsTab.moveLeftTitle")}
                  className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-30"
                >
                  ←
                </button>
                <button
                  onClick={() => move(col.id, "right")}
                  disabled={i === columns.length - 1}
                  title={t("settingsTab.moveRightTitle")}
                  className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-30"
                >
                  →
                </button>
                <button onClick={() => remove(col.id)} title={t("settingsTab.deleteColumnTitle")} className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-danger-soft hover:text-danger">
                  ✕
                </button>
              </span>
            )}
          </div>
        ))}
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <input
            value={newColName}
            onChange={(e) => setNewColName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addColumn()}
            placeholder={t("settingsTab.newColumnPlaceholder")}
            className="min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
          />
          <Button variant="outline" onClick={addColumn} disabled={creating || !newColName.trim()}>
            {t("settingsTab.addColumnButton")}
          </Button>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] text-text-3">{t("settingsTab.columnsFooterNote")}</p>
    </div>
  );
}

function PropertiesSettings({ projectId }: { projectId: string }) {
  const { t } = useTranslation("board");
  const [definitions, setDefinitions] = useState<PropertyDefinition[] | null>(null);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<(typeof ISSUE_PROPERTY_TYPES)[number]>("text");
  const [creating, setCreating] = useState(false);

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
    try {
      await createIssuePropertyDefinitionFn({ data: { projectId, name: newName.trim(), type: newType } });
      setNewName("");
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  async function rename(definitionId: string, name: string) {
    await updateIssuePropertyDefinitionFn({ data: { projectId, definitionId, name } });
    await refresh();
  }

  async function retype(definitionId: string, type: (typeof ISSUE_PROPERTY_TYPES)[number]) {
    await updateIssuePropertyDefinitionFn({ data: { projectId, definitionId, type } });
    await refresh();
  }

  async function toggleVisible(definitionId: string, visibleOnCard: boolean) {
    await updateIssuePropertyDefinitionFn({ data: { projectId, definitionId, visibleOnCard } });
    await refresh();
  }

  async function remove(definitionId: string) {
    await deleteIssuePropertyDefinitionFn({ data: { projectId, definitionId } });
    await refresh();
  }

  if (!definitions) return null;
  const visCount = definitions.filter((d) => d.visibleOnCard).length;

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold">{t("settingsTab.propertiesHeading")}</h2>
      <p className="mb-4 text-[13px] text-text-2">
        {t("settingsTab.propertiesDescPart1")}
        <strong className="text-text">{t("settingsTab.propertiesDescBold", { count: visCount })}</strong>
      </p>
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-2 px-3.5 py-2 text-[11px] font-semibold text-text-2">
          {t("settingsTab.propertiesCountSummary", { visible: visCount, total: definitions.length })}
        </div>
        {definitions.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2.5 border-b border-border px-3.5 py-2 last:border-b-0">
            <span className="flex min-w-[190px] flex-1 items-center gap-1.5">
              <input
                defaultValue={p.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && rename(p.id, e.target.value.trim())}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[12.5px] font-medium outline-none focus:border-border-2 focus:bg-surface"
              />
              {p.isCore && <Badge>{t("settingsTab.coreBadge")}</Badge>}
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-text-3">
              {t("settingsTab.typeLabel")}
              <select
                value={p.type}
                onChange={(e) => retype(p.id, e.target.value as (typeof ISSUE_PROPERTY_TYPES)[number])}
                className="rounded-md border border-border-2 bg-surface px-2 py-1 text-[12px] outline-none"
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
              <button onClick={() => remove(p.id)} title={t("settingsTab.deletePropertyTitle")} className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-danger-soft hover:text-danger">
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addProperty()}
            placeholder={t("settingsTab.newPropertyPlaceholder")}
            className="min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as (typeof ISSUE_PROPERTY_TYPES)[number])}
            className="rounded-md border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
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
      <p className="mt-3 text-[11.5px] text-text-3">{t("settingsTab.propertiesFooterNote")}</p>
    </div>
  );
}
