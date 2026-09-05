import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Tabs } from "@kompast/ui/Tabs";
import { Badge } from "@kompast/ui/Badge";
import { Button } from "@kompast/ui/Button";
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

const SUB_TABS = [
  { key: "columns", label: "Kolom kanban" },
  { key: "properties", label: "Properti tiket" },
];

export function ProjectSettingsTab({ data }: { data: BoardData }) {
  const [subTab, setSubTab] = useState<"columns" | "properties">("columns");

  return (
    <div className="p-6">
      <Tabs items={SUB_TABS} active={subTab} onChange={(key) => setSubTab(key as typeof subTab)} className="mb-5" />
      {subTab === "columns" && <ColumnsSettings data={data} />}
      {subTab === "properties" && <PropertiesSettings projectId={data.project.id} />}
    </div>
  );
}

const COLUMN_TONES = ["var(--indigo)", "var(--violet)", "var(--amber)", "var(--green)", "var(--danger)", "var(--text-3)"];

function ColumnsSettings({ data }: { data: BoardData }) {
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
    if (!window.confirm("Hapus kolom ini? Tiketnya akan dikembalikan ke Backlog.")) return;
    await deleteBoardColumnFn({ data: { projectId: data.project.id, columnId } });
    await router.invalidate();
  }

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold">Kolom kanban</h2>
      <p className="mb-4 text-[13px] text-text-2">
        Kategori kolom menentukan alur kerja project. <strong className="text-text">Backlog selalu ada</strong> dan menjadi satu-satunya pintu masuk tiket
        baru; kolom lain bisa ditambah, diubah, diurutkan, atau dihapus.
      </p>
      {flowText && (
        <div className="mb-4 flex items-center gap-2 rounded-[11px] border border-dashed border-border-2 px-3.5 py-2.5 text-[12.5px] text-text-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-3">Alur</span>
          <span className="font-medium">{flowText}</span>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-2 px-3.5 py-2 text-[11px] font-semibold text-text-2">
          {columns.length} kolom · Backlog terkunci di posisi pertama
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
              {col.isBacklog && <Badge>tetap</Badge>}
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
                  title="Geser ke kiri"
                  className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-30"
                >
                  ←
                </button>
                <button
                  onClick={() => move(col.id, "right")}
                  disabled={i === columns.length - 1}
                  title="Geser ke kanan"
                  className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-30"
                >
                  →
                </button>
                <button onClick={() => remove(col.id)} title="Hapus kolom" className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-danger-soft hover:text-danger">
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
            placeholder="Nama kolom baru"
            className="min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
          />
          <Button variant="outline" onClick={addColumn} disabled={creating || !newColName.trim()}>
            + Tambah kolom
          </Button>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] text-text-3">
        Menghapus kolom tidak menghapus tiketnya — semua tiket di dalamnya dikembalikan ke Backlog. Batas WIP kosong berarti tanpa batas.
      </p>
    </div>
  );
}

function PropertiesSettings({ projectId }: { projectId: string }) {
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
      <h2 className="mb-1 text-lg font-semibold">Properti tiket</h2>
      <p className="mb-4 text-[13px] text-text-2">
        Properti ini membentuk skema database project: kolom di view Tabel, isi kartu Kanban, dan variabel yang bisa dipakai otomasi. Tambah, hapus, ubah
        nama, atau ganti tipe datanya — perubahan langsung terlihat di semua view. <strong className="text-text">{visCount} properti tampil di kartu.</strong>
      </p>
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="border-b border-border bg-surface-2 px-3.5 py-2 text-[11px] font-semibold text-text-2">
          {visCount} dari {definitions.length} properti tampil di kartu
        </div>
        {definitions.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-2.5 border-b border-border px-3.5 py-2 last:border-b-0">
            <span className="flex min-w-[190px] flex-1 items-center gap-1.5">
              <input
                defaultValue={p.name}
                onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && rename(p.id, e.target.value.trim())}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[12.5px] font-medium outline-none focus:border-border-2 focus:bg-surface"
              />
              {p.isCore && <Badge>inti</Badge>}
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-text-3">
              Tipe
              <select
                value={p.type}
                onChange={(e) => retype(p.id, e.target.value as (typeof ISSUE_PROPERTY_TYPES)[number])}
                className="rounded-md border border-border-2 bg-surface px-2 py-1 text-[12px] outline-none"
              >
                {ISSUE_PROPERTY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </span>
            <label className="flex items-center gap-1.5 text-[10px] text-text-3">
              Di kartu
              <input type="checkbox" checked={p.visibleOnCard} onChange={(e) => toggleVisible(p.id, e.target.checked)} />
            </label>
            {!p.isCore && (
              <button onClick={() => remove(p.id)} title="Hapus properti" className="rounded px-1.5 py-0.5 text-[11px] text-text-3 hover:bg-danger-soft hover:text-danger">
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
            placeholder="Nama properti baru"
            className="min-w-0 flex-1 rounded-md border border-border-2 bg-surface px-2.5 py-1.5 text-[12.5px] outline-none"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as (typeof ISSUE_PROPERTY_TYPES)[number])}
            className="rounded-md border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
          >
            {ISSUE_PROPERTY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <Button variant="outline" onClick={addProperty} disabled={creating || !newName.trim()}>
            + Tambah properti
          </Button>
        </div>
      </div>
      <p className="mt-3 text-[11.5px] text-text-3">Properti inti tetap bisa diganti nama dan disembunyikan, tapi tidak bisa dihapus.</p>
    </div>
  );
}
