import { createFileRoute, useRouter, useNavigate, useLoaderData, ClientOnly, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Kanban, Table2, Map as MapIcon, FileText, Zap, Download, Settings, Search, Inbox } from "lucide-react";
import {
  DndContext,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { Badge } from "@kompast/ui/Badge";
import { Avatar } from "@kompast/ui/Avatar";
import { Button } from "@kompast/ui/Button";
import { Tabs } from "@kompast/ui/Tabs";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { useConfirmArm } from "@/lib/use-confirm-arm";
import { getProjectBoardFn } from "@/lib/server-fns/projects";
import { moveIssueFn, createIssueFn } from "@/lib/server-fns/issues";
import { listProjectPagesFn, createPageFn } from "@/lib/server-fns/pages";
import { streamAiCompletion } from "@/lib/ai-stream-client";
import { listImportRunsFn, startJiraImportFn } from "@/lib/server-fns/imports";
import {
  listSprintsFn,
  listBacklogFn,
  getSprintDetailFn,
  createSprintFn,
  updateSprintFn,
  startSprintFn,
  completeSprintFn,
  addIssueToSprintFn,
  removeIssueFromSprintFn,
  sendSprintSummaryEmailFn,
} from "@/lib/server-fns/sprints";
import { getPageEditorAccessFn } from "@/lib/server-fns/pages";
import { DocEditor } from "@/components/docs/Editor";
import { getRoadmapFn } from "@/lib/server-fns/roadmap";
import { listAutomationRulesFn, listAutomationRunsFn, createAutomationRuleFn, setAutomationRuleEnabledFn, deleteAutomationRuleFn } from "@/lib/server-fns/automation";
import { TableView } from "@/components/board/TableView";
import { ProjectSettingsTab } from "@/components/board/ProjectSettingsTab";
import { DocsTree } from "@/components/docs/DocsTree";

export const Route = createFileRoute("/_app/projects/$teamId/$projectKey")({
  loader: ({ params }) => getProjectBoardFn({ data: { teamId: params.teamId, projectKey: params.projectKey } }),
  component: ProjectPage,
});

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };

function ProjectPage() {
  const { t } = useTranslation("board");
  const data = Route.useLoaderData();
  const router = useRouter();
  const [view, setView] = useState("backlog");

  const iconProps = { size: 14, strokeWidth: 1.75 };
  const VIEW_TABS = [
    { key: "backlog", label: t("tabs.backlog"), icon: <Inbox {...iconProps} /> },
    { key: "board", label: t("tabs.board"), icon: <Kanban {...iconProps} /> },
    { key: "table", label: t("tabs.table"), icon: <Table2 {...iconProps} /> },
    { key: "roadmap", label: t("tabs.roadmap"), icon: <MapIcon {...iconProps} /> },
    { key: "docs", label: t("tabs.docs"), icon: <FileText {...iconProps} /> },
    { key: "automation", label: t("tabs.automation"), icon: <Zap {...iconProps} /> },
    { key: "import", label: t("tabs.import"), icon: <Download {...iconProps} /> },
  ];
  const viewTabs = data.canManageProject
    ? [...VIEW_TABS, { key: "settings", label: t("tabs.settings"), icon: <Settings {...iconProps} /> }]
    : VIEW_TABS;
  const [addingIssue, setAddingIssue] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [newIssueError, setNewIssueError] = useState<string | null>(null);
  const [backlogRefreshSignal, setBacklogRefreshSignal] = useState(0);

  const defaultType = data.issueTypes.find((tp) => !tp.isSubtask);
  const backlogColumn = data.columns.find((c) => c.isBacklog) ?? data.columns[0];
  const teamId = data.project.teamId ?? "none";

  // The "+ New issue" header entry only applies to Backlog/Board — reset any
  // in-progress entry when navigating away so it doesn't linger hidden.
  useEffect(() => {
    if (view !== "backlog" && view !== "board") {
      setAddingIssue(false);
      setNewTitle("");
      setNewIssueError(null);
    }
  }, [view]);

  async function submitNewIssue() {
    if (!newTitle.trim() || !defaultType || !backlogColumn?.statusIds[0]) return;
    setCreating(true);
    setNewIssueError(null);
    try {
      await createIssueFn({
        data: {
          projectId: data.project.id,
          typeId: defaultType.id,
          statusId: backlogColumn.statusIds[0],
          title: newTitle.trim(),
        },
      });
      setNewTitle("");
      setAddingIssue(false);
      setBacklogRefreshSignal((n) => n + 1);
      await router.invalidate();
    } catch (err) {
      setNewIssueError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="border-b border-border bg-surface-2 px-6 pt-5">
        <div className="flex items-start gap-3.5">
          <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-indigo text-[13px] font-bold text-white">
            {data.project.key.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="mb-1 type-title">{data.project.name}</h1>
            <p className="type-label text-text-2">
              {data.project.key} · {t("header.ticketCount", { count: data.columns.reduce((n, c) => n + c.issues.length, 0) })}
            </p>
          </div>
          {(view === "backlog" || view === "board") && (
            <div className="flex gap-1.5">
              {addingIssue ? (
                <>
                  <input
                    autoFocus
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitNewIssue();
                      if (e.key === "Escape") setAddingIssue(false);
                    }}
                    placeholder={t("header.newIssuePlaceholder")}
                    className="rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
                  />
                  <Button variant="primary" onClick={submitNewIssue} disabled={creating}>
                    {t("save")}
                  </Button>
                  <Button variant="outline" onClick={() => setAddingIssue(false)}>
                    {t("cancel")}
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => setAddingIssue(true)}>
                  {t("header.newIssueButton")}
                </Button>
              )}
            </div>
          )}
        </div>
        <Tabs items={viewTabs} active={view} onChange={setView} className="mt-4" />
        {newIssueError && (
          <p className="mb-4 mt-2 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{newIssueError}</p>
        )}
      </div>

      {view === "board" && (
        data.hasAnySprint
          ? <BoardView data={data} />
          : <SprintSetupWizard boardId={data.board.id} onCreated={async () => { await router.invalidate(); setView("backlog"); }} />
      )}
      {view === "backlog" && (
        data.hasAnySprint
          ? (
            <BacklogTab
              projectId={data.project.id}
              boardId={data.board.id}
              columns={data.columns}
              teamId={teamId}
              projectKey={data.project.key}
              refreshSignal={backlogRefreshSignal}
            />
          )
          : <SprintSetupWizard boardId={data.board.id} onCreated={() => router.invalidate()} />
      )}
      {view === "table" && <TableTab boardId={data.board.id} data={data} />}
      {view === "roadmap" && <RoadmapTab projectId={data.project.id} projectKey={data.project.key} />}
      {view === "docs" && <ProjectDocsTab projectId={data.project.id} />}
      {view === "automation" && <AutomationTab projectId={data.project.id} data={data} />}
      {view === "import" && <ImportTab projectId={data.project.id} boardId={data.board.id} />}
      {view === "settings" && data.canManageProject && <ProjectSettingsTab data={data} />}
      {![...VIEW_TABS.map((tb) => tb.key), "settings"].includes(view) && (
        <div className="p-10 text-center type-body text-text-3">
          {t("header.viewNotBuilt", { label: viewTabs.find((tb) => tb.key === view)?.label })}
        </div>
      )}
    </div>
  );
}

type BoardData = Awaited<ReturnType<typeof getProjectBoardFn>>;

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * The system's one full "peak" moment reused here at a deliberately larger
 * scale for the two full-panel empty states on this page (Docs, Roadmap):
 * the Compass Mark's own tile+diamond construction (never a large fill —
 * still a small mark, so the One Loud Color Rule holds), the board's own
 * grid-dot texture (already used behind the kanban columns), and a mono
 * overline — all devices this page already owns, just turned up here.
 */
function EmptyStatePanel({ overline, heading, subtext }: { overline: string; heading: string; subtext?: string }) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-surface px-10 py-16 text-center"
      style={{ backgroundImage: "radial-gradient(var(--grid) 1px, transparent 1px)", backgroundSize: "22px 22px" }}
    >
      <div className="mx-auto mb-5 flex h-[42px] w-[42px] items-center justify-center rounded-[12px] bg-accent">
        <div className="h-[11px] w-[11px] rotate-45 rounded-sm bg-white" />
      </div>
      <p className="mb-1.5 type-label-overline text-text-3">{overline}</p>
      <p className="mx-auto max-w-[380px] type-display text-text">{heading}</p>
      {subtext && <p className="mx-auto mt-2 max-w-[380px] type-body leading-relaxed text-text-2">{subtext}</p>}
    </div>
  );
}

function ProjectDocsTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation("board");
  const navigate = useNavigate();
  const [pages, setPages] = useState<Awaited<ReturnType<typeof listProjectPagesFn>> | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjectPagesFn({ data: projectId }).then(setPages);
  }, [projectId]);

  async function newPage() {
    setCreating(true);
    setError(null);
    try {
      const page = await createPageFn({ data: { projectId } });
      await navigate({ to: "/docs/$pageId", params: { pageId: page.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="px-6 py-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="type-body text-text-3">{t("docsTab.subtitle")}</p>
        <Button variant="primary" onClick={newPage} disabled={creating}>
          {t("docsTab.newPageButton")}
        </Button>
      </div>
      {error && <p className="mb-4 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>}
      {pages === null ? (
        <p className="type-body text-text-3">{t("loadingEllipsis")}</p>
      ) : pages.length === 0 ? (
        <EmptyStatePanel overline={t("tabs.docs")} heading={t("docsTab.emptyState")} />
      ) : (
        <div className="rounded-xl border border-border bg-surface p-2">
          <DocsTree pages={pages} />
        </div>
      )}
    </div>
  );
}

type SprintSummary = Awaited<ReturnType<typeof listSprintsFn>>[number];
type BacklogIssue = Awaited<ReturnType<typeof listBacklogFn>>[number];
type SprintDetail = Awaited<ReturnType<typeof getSprintDetailFn>>;

function SprintHeading({
  sprint,
  isRenaming,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onSaveRename,
  onCancelRename,
  t,
}: {
  sprint: SprintSummary;
  isRenaming: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: (sprint: SprintSummary) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  if (isRenaming) {
    return (
      <input
        autoFocus
        value={renameValue}
        onChange={(e) => onRenameValueChange(e.target.value)}
        onBlur={onSaveRename}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSaveRename();
          if (e.key === "Escape") onCancelRename();
        }}
        className="rounded-[7px] border border-border-2 bg-surface px-2 py-1 text-[13px] outline-none"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => onStartRename(sprint)}
      className="type-label-overline text-text-3 hover:text-text-2"
      title={t("sprint.renameHint")}
    >
      {sprint.name}
    </button>
  );
}

function SprintSection({
  sprint,
  detail,
  busy,
  renamingId,
  renameValue,
  onRenameValueChange,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onStart,
  onComplete,
  onRemoveFromSprint,
  onMoveToColumn,
  nonBacklogColumns,
  aiBusy,
  aiError,
  aiSummary,
  onGenerateAiSummary,
  teamId,
  projectKey,
  t,
}: {
  sprint: SprintSummary;
  detail: SprintDetail | undefined;
  busy: boolean;
  renamingId: string | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onStartRename: (sprint: SprintSummary) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onStart: (sprintId: string) => void;
  onComplete: (sprintId: string) => void;
  onRemoveFromSprint: (issueId: string) => void;
  onMoveToColumn: (issueId: string, toStatusId: string) => void;
  nonBacklogColumns: { id: string; name: string; statusIds: string[] }[];
  aiBusy: boolean;
  aiError: string | null;
  aiSummary: string | null;
  onGenerateAiSummary: (sprintId: string) => void;
  teamId: string;
  projectKey: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <SprintHeading
          sprint={sprint}
          isRenaming={renamingId === sprint.id}
          renameValue={renameValue}
          onRenameValueChange={onRenameValueChange}
          onStartRename={onStartRename}
          onSaveRename={onSaveRename}
          onCancelRename={onCancelRename}
          t={t}
        />
        {sprint.state === "future" && (
          <Button variant="outline" disabled={busy} onClick={() => onStart(sprint.id)}>
            {t("sprint.start")}
          </Button>
        )}
        {sprint.state === "active" && (
          <Button variant="outline" disabled={busy} onClick={() => onComplete(sprint.id)}>
            {t("sprint.complete")}
          </Button>
        )}
      </div>
      {detail && (
        <p className="mb-2 type-body text-text-2">
          {t("sprint.scopeLabel")} <strong>{detail.report.scopeIssueCount}</strong> {t("sprint.issuesUnit")} / <strong>{detail.report.scopePoints}</strong> {t("sprint.pointsUnit")}
          {" · "}
          {t("sprint.completedLabel")} <strong>{detail.report.completedIssueCount}</strong> {t("sprint.issuesUnit")} / <strong>{detail.report.completedPoints}</strong> {t("sprint.pointsUnit")}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        {(!detail || detail.issues.length === 0) && <p className="type-body text-text-3">{t("sprint.noIssuesInSprint")}</p>}
        {detail?.issues.map((issue) => (
          <div key={issue.id} className="flex items-center justify-between gap-2 rounded-[9px] border border-border px-2 py-1.5">
            <Link
              to="/issues/$teamId/$projectKey/$issueKeySeq"
              params={{ teamId, projectKey, issueKeySeq: String(issue.keySeq) }}
              className="truncate type-body hover:text-accent"
            >
              {issue.title}
            </Link>
            <div className="flex flex-none items-center gap-1.5">
              <select
                disabled={busy}
                value={nonBacklogColumns.find((c) => c.statusIds.includes(issue.statusId))?.id ?? ""}
                onChange={(e) => {
                  const col = nonBacklogColumns.find((c) => c.id === e.target.value);
                  if (col?.statusIds[0]) onMoveToColumn(issue.id, col.statusIds[0]);
                }}
                className="kp-select rounded-[7px] border border-border-2 bg-surface px-2 py-1 text-[12px] outline-none"
              >
                <option value="" disabled>
                  {t("sprint.moveToColumnPlaceholder")}
                </option>
                {nonBacklogColumns.map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.name}
                  </option>
                ))}
              </select>
              <Button variant="outline" disabled={busy} onClick={() => onRemoveFromSprint(issue.id)}>
                {t("sprint.removeButton")}
              </Button>
            </div>
          </div>
        ))}
      </div>
      {sprint.state === "active" && (
        <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <p className="type-label-overline text-text-3">{t("sprint.aiSummaryHeading")}</p>
            <Button variant="outline" onClick={() => onGenerateAiSummary(sprint.id)} disabled={aiBusy}>
              {aiBusy ? t("sprint.writingEllipsis") : t("sprint.generateSummary")}
            </Button>
          </div>
          {aiError && <p className="type-body text-danger">{aiError}</p>}
          {aiSummary !== null && !aiError && <p className="whitespace-pre-wrap type-body text-text-2">{aiSummary || "…"}</p>}
        </div>
      )}
    </div>
  );
}

function BacklogTab({
  projectId,
  boardId,
  columns,
  teamId,
  projectKey,
  refreshSignal,
}: {
  projectId: string;
  boardId: string;
  columns: BoardData["columns"];
  teamId: string;
  projectKey: string;
  refreshSignal: number;
}) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const [sprints, setSprints] = useState<SprintSummary[] | null>(null);
  const [backlog, setBacklog] = useState<BacklogIssue[] | null>(null);
  const [details, setDetails] = useState<Record<string, SprintDetail>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const nonBacklogColumns = columns.filter((c) => !c.isBacklog);

  async function refresh() {
    const [list, backlogList] = await Promise.all([listSprintsFn({ data: boardId }), listBacklogFn({ data: projectId })]);
    setSprints(list);
    setBacklog(backlogList);
    const relevant = list.filter((s) => s.state !== "closed");
    const detailEntries = await Promise.all(relevant.map((s) => getSprintDetailFn({ data: s.id }).then((d) => [s.id, d] as const)));
    setDetails(Object.fromEntries(detailEntries));
  }

  useEffect(() => {
    refresh();
    setAiSummary(null);
    setAiError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, boardId, refreshSignal]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setBusy(false);
    }
  }

  const createFutureSprint = () => withBusy(async () => { await createSprintFn({ data: { boardId } }); });
  const handleStart = (sprintId: string) => withBusy(async () => { await startSprintFn({ data: sprintId }); });
  const handleComplete = (sprintId: string) => withBusy(async () => { await completeSprintFn({ data: { sprintId } }); });
  const addToSprint = (sprintId: string, issueId: string) => withBusy(async () => { await addIssueToSprintFn({ data: { sprintId, issueId } }); });
  const removeFromSprint = (issueId: string) => withBusy(async () => { await removeIssueFromSprintFn({ data: issueId }); });
  const moveToColumn = (issueId: string, toStatusId: string) => withBusy(async () => { await moveIssueFn({ data: { issueId, toStatusId } }); });

  async function saveRename(sprintId: string) {
    if (renamingId !== sprintId) return;
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (!trimmed) return;
    await withBusy(async () => { await updateSprintFn({ data: { sprintId, name: trimmed } }); });
  }

  async function generateAiSummary(sprintId: string) {
    setAiBusy(true);
    setAiError(null);
    setAiSummary("");
    try {
      await streamAiCompletion({ feature: "sprint-summary", sprintId }, (delta) => {
        setAiSummary((prev) => (prev ?? "") + delta);
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t("sprint.aiSummaryFailed"));
    } finally {
      setAiBusy(false);
    }
  }

  if (sprints === null || backlog === null) {
    return <p className="p-6 type-body text-text-3">{t("loadingEllipsis")}</p>;
  }

  const activeSprint = sprints.find((s) => s.state === "active") ?? null;
  const futureSprints = sprints.filter((s) => s.state === "future").sort((a, b) => a.number - b.number);

  return (
    <div className="flex flex-col gap-4 p-6">
      {error && <p className="rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>}

      {activeSprint && (
        <div>
          <p className="mb-2 type-label-overline text-text-3">{t("sprint.activeSectionHeading")}</p>
          <SprintSection
            sprint={activeSprint}
            detail={details[activeSprint.id]}
            busy={busy}
            renamingId={renamingId}
            renameValue={renameValue}
            onRenameValueChange={setRenameValue}
            onStartRename={(s) => { setRenamingId(s.id); setRenameValue(s.name); }}
            onSaveRename={() => saveRename(activeSprint.id)}
            onCancelRename={() => setRenamingId(null)}
            onStart={handleStart}
            onComplete={handleComplete}
            onRemoveFromSprint={removeFromSprint}
            onMoveToColumn={moveToColumn}
            nonBacklogColumns={nonBacklogColumns}
            aiBusy={aiBusy}
            aiError={aiError}
            aiSummary={aiSummary}
            onGenerateAiSummary={generateAiSummary}
            teamId={teamId}
            projectKey={projectKey}
            t={t}
          />
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <p className="type-label-overline text-text-3">{t("sprint.futureSectionHeading")}</p>
          <Button variant="outline" disabled={busy} onClick={createFutureSprint}>
            {t("sprint.createSprintButton")}
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          {futureSprints.length === 0 && <p className="type-body text-text-3">{t("sprint.noFutureSprints")}</p>}
          {futureSprints.map((s) => (
            <SprintSection
              key={s.id}
              sprint={s}
              detail={details[s.id]}
              busy={busy}
              renamingId={renamingId}
              renameValue={renameValue}
              onRenameValueChange={setRenameValue}
              onStartRename={(sp) => { setRenamingId(sp.id); setRenameValue(sp.name); }}
              onSaveRename={() => saveRename(s.id)}
              onCancelRename={() => setRenamingId(null)}
              onStart={handleStart}
              onComplete={handleComplete}
              onRemoveFromSprint={removeFromSprint}
              onMoveToColumn={moveToColumn}
              nonBacklogColumns={nonBacklogColumns}
              aiBusy={aiBusy}
              aiError={aiError}
              aiSummary={aiSummary}
              onGenerateAiSummary={generateAiSummary}
              teamId={teamId}
              projectKey={projectKey}
              t={t}
            />
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="mb-2 type-label-overline text-text-3">{t("sprint.backlogHeading")}</p>
        <div className="flex flex-col gap-1.5">
          {backlog.length === 0 && <p className="type-body text-text-3">{t("sprint.backlogEmpty")}</p>}
          {backlog.map((issue) => (
            <div key={issue.id} className="flex items-center justify-between gap-2 rounded-[9px] border border-border px-2 py-1.5">
              <Link
                to="/issues/$teamId/$projectKey/$issueKeySeq"
                params={{ teamId, projectKey, issueKeySeq: String(issue.keySeq) }}
                className="truncate type-body hover:text-accent"
              >
                {issue.title}
              </Link>
              <div className="flex flex-none items-center gap-1.5">
                <select
                  disabled={busy}
                  value={nonBacklogColumns.find((c) => c.statusIds.includes(issue.statusId))?.id ?? ""}
                  onChange={(e) => {
                    const col = nonBacklogColumns.find((c) => c.id === e.target.value);
                    if (col?.statusIds[0]) moveToColumn(issue.id, col.statusIds[0]);
                  }}
                  className="kp-select rounded-[7px] border border-border-2 bg-surface px-2 py-1 text-[12px] outline-none"
                >
                  <option value="" disabled>
                    {t("sprint.moveToColumnPlaceholder")}
                  </option>
                  {nonBacklogColumns.map((col) => (
                    <option key={col.id} value={col.id}>
                      {col.name}
                    </option>
                  ))}
                </select>
                <select
                  disabled={busy || (!activeSprint && futureSprints.length === 0)}
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) addToSprint(e.target.value, issue.id);
                    e.target.value = "";
                  }}
                  className="kp-select rounded-[7px] border border-border-2 bg-surface px-2 py-1 text-[12px] outline-none"
                >
                  <option value="" disabled>
                    {t("sprint.addToSprintButton")}
                  </option>
                  {activeSprint && <option value={activeSprint.id}>{activeSprint.name}</option>}
                  {futureSprints.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Reuses TableView verbatim (same grouping/sort/filter/drag-reorder,
 * inline links, same project-level saved-view config) filtered down to
 * just this sprint's issues — the plan's "sprint review = the sprint's
 * view in table mode with grouping" ask, without a separate saved_view row
 * per sprint (one project-level table preference is shared across every
 * sprint's review here, a deliberate simplification). Cells are still
 * read-only (linking out to the issue detail page to edit) — full
 * inline-cell editing is a separate, larger gap that applies to the whole
 * table view feature, not unique to sprint review.
 *
 * `sprintIssues` carries each issue's sprint-scoped manual-reorder rank
 * (sprint_issue.rank, from listSprintIssues) — merged onto the flattened
 * boardData issues here so TableView's "Manual order" sort/drag can use it
 * instead of the global issue.rank (see sprint_issue schema's rank doc
 * comment on why these are kept separate).
 */
function SprintReviewTable({
  boardData,
  sprintId,
  sprintIssues,
  onReordered,
}: {
  boardData: BoardData;
  sprintId: string;
  sprintIssues: { id: string; sprintRank: string | null }[];
  onReordered: () => void;
}) {
  const sprintRankByIssueId = new Map(sprintIssues.map((i) => [i.id, i.sprintRank]));
  const filtered: BoardData = {
    ...boardData,
    columns: boardData.columns.map((c) => ({
      ...c,
      issues: c.issues.filter((i) => sprintRankByIssueId.has(i.id)).map((i) => ({ ...i, sprintRank: sprintRankByIssueId.get(i.id) ?? null })),
    })),
  };
  return <TableView data={filtered} sprintContext={{ sprintId, onReordered }} />;
}

type SprintDetailWithMinutes = Awaited<ReturnType<typeof getSprintDetailFn>>;
type SubTabKey = "review" | "action" | "retro";

function TableTab({ boardId, data }: { boardId: string; data: BoardData }) {
  const { t } = useTranslation("board");
  const shell = useLoaderData({ from: "/_app" });
  const [sprints, setSprints] = useState<Awaited<ReturnType<typeof listSprintsFn>> | null>(null);
  const [selectedSprintId, setSelectedSprintId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SprintDetailWithMinutes | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<SubTabKey>("review");
  const [actionAccess, setActionAccess] = useState<Awaited<ReturnType<typeof getPageEditorAccessFn>> | null>(null);
  const [retroAccess, setRetroAccess] = useState<Awaited<ReturnType<typeof getPageEditorAccessFn>> | null>(null);

  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState<string[]>([]);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSentMessage, setEmailSentMessage] = useState<string | null>(null);

  useEffect(() => {
    listSprintsFn({ data: boardId }).then((list) => {
      setSprints(list);
      const active = list.find((s) => s.state === "active");
      setSelectedSprintId((current) => current ?? active?.id ?? list[0]?.id ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  async function refreshDetail(sprintId: string) {
    setDetail(await getSprintDetailFn({ data: sprintId }));
  }

  useEffect(() => {
    setDetail(null);
    setAiSummary(null);
    setAiError(null);
    if (!selectedSprintId) return;
    refreshDetail(selectedSprintId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSprintId]);

  useEffect(() => {
    setActionAccess(null);
    if (activeSubTab !== "action" || !detail?.minutesPageId) return;
    getPageEditorAccessFn({ data: detail.minutesPageId }).then(setActionAccess);
  }, [activeSubTab, detail?.minutesPageId]);

  useEffect(() => {
    setRetroAccess(null);
    if (activeSubTab !== "retro" || !detail?.retroPageId) return;
    getPageEditorAccessFn({ data: detail.retroPageId }).then(setRetroAccess);
  }, [activeSubTab, detail?.retroPageId]);

  async function generateAiSummary(sprintId: string) {
    setAiBusy(true);
    setAiError(null);
    setAiSummary("");
    try {
      await streamAiCompletion({ feature: "sprint-summary", sprintId }, (delta) => {
        setAiSummary((prev) => (prev ?? "") + delta);
      });
    } catch (err) {
      setAiError(err instanceof Error ? err.message : t("sprint.aiSummaryFailed"));
    } finally {
      setAiBusy(false);
    }
  }

  function openEmailModal() {
    const sprint = sprints?.find((s) => s.id === selectedSprintId);
    setEmailRecipients(data.projectMembers.map((m) => m.email));
    setEmailSubject(sprint ? `${data.project.name} — ${sprint.name} Summary` : `${data.project.name} — Sprint Summary`);
    setEmailBody(aiSummary ?? "");
    setEmailError(null);
    setEmailSentMessage(null);
    setEmailModalOpen(true);
  }

  async function sendEmail() {
    if (!selectedSprintId || emailRecipients.length === 0) return;
    setEmailSending(true);
    setEmailError(null);
    try {
      const result = await sendSprintSummaryEmailFn({
        data: { sprintId: selectedSprintId, recipients: emailRecipients, subject: emailSubject, body: emailBody },
      });
      setEmailSentMessage(t("sprint.emailSentConfirmation", { count: result.sent }));
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : t("sprint.emailSendFailed"));
    } finally {
      setEmailSending(false);
    }
  }

  if (sprints === null) {
    return <p className="p-6 type-body text-text-3">{t("loadingEllipsis")}</p>;
  }
  if (sprints.length === 0) {
    return <TableView data={data} />;
  }

  const subTabItems = [
    { key: "review", label: t("sprint.reviewHeading") },
    { key: "action", label: t("sprint.actionHeading") },
    { key: "retro", label: t("sprint.retrospectiveHeading") },
  ];

  return (
    <div className="flex flex-col gap-3 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <select
          value={selectedSprintId ?? ""}
          onChange={(e) => setSelectedSprintId(e.target.value || null)}
          className="kp-select w-fit rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
        >
          {sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => selectedSprintId && generateAiSummary(selectedSprintId)} disabled={aiBusy || !selectedSprintId}>
            {aiBusy ? t("sprint.writingEllipsis") : t("sprint.generateSummary")}
          </Button>
          {aiSummary !== null && !aiError && (
            <Button variant="outline" onClick={openEmailModal}>
              {t("sprint.sendByEmailButton")}
            </Button>
          )}
        </div>
      </div>
      {aiError && <p className="type-body text-danger">{aiError}</p>}
      {aiSummary !== null && !aiError && (
        <p className="whitespace-pre-wrap rounded-[9px] border border-border bg-surface-2 px-3 py-2 type-body text-text-2">{aiSummary || "…"}</p>
      )}

      <Tabs items={subTabItems} active={activeSubTab} onChange={(k) => setActiveSubTab(k as SubTabKey)} />

      <div className="rounded-xl border border-border bg-surface">
        {activeSubTab === "review" &&
          (detail ? (
            <SprintReviewTable
              boardData={data}
              sprintId={selectedSprintId!}
              sprintIssues={detail.issues.map((i) => ({ id: i.id, sprintRank: i.sprintRank ?? null }))}
              onReordered={() => refreshDetail(selectedSprintId!)}
            />
          ) : (
            <p className="p-6 type-body text-text-3">{t("loadingEllipsis")}</p>
          ))}
        {activeSubTab === "action" && (
          <div className="p-3">
            {detail && !detail.minutesPageId ? (
              <p className="type-body text-text-3">{t("sprint.actionUnavailable")}</p>
            ) : actionAccess ? (
              <ClientOnly fallback={<div className="min-h-[40vh] rounded-[9px] border border-border" />}>
                <DocEditor
                  pageId={actionAccess.page.id}
                  collabToken={actionAccess.collabToken}
                  collabWsUrl={actionAccess.collabWsUrl}
                  canEdit={actionAccess.canEdit}
                  userId={shell.user.id}
                  userName={shell.user.name}
                />
              </ClientOnly>
            ) : (
              <div className="min-h-[40vh] rounded-[9px] border border-border" />
            )}
          </div>
        )}
        {activeSubTab === "retro" && (
          <div className="p-3">
            {detail && !detail.retroPageId ? (
              <p className="type-body text-text-3">{t("sprint.retrospectiveUnavailable")}</p>
            ) : retroAccess ? (
              <ClientOnly fallback={<div className="min-h-[40vh] rounded-[9px] border border-border" />}>
                <DocEditor
                  pageId={retroAccess.page.id}
                  collabToken={retroAccess.collabToken}
                  collabWsUrl={retroAccess.collabWsUrl}
                  canEdit={retroAccess.canEdit}
                  userId={shell.user.id}
                  userName={shell.user.name}
                />
              </ClientOnly>
            ) : (
              <div className="min-h-[40vh] rounded-[9px] border border-border" />
            )}
          </div>
        )}
      </div>

      {emailModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEmailModalOpen(false)}>
          <div
            className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="type-label-overline text-text-3">{t("sprint.emailModalHeading")}</p>
            <div>
              <p className="mb-1 type-body text-text-2">{t("sprint.emailToLabel")}</p>
              <div className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-[9px] border border-border p-2">
                {data.projectMembers.map((m) => (
                  <label key={m.id} className="flex items-center gap-2 type-body">
                    <input
                      type="checkbox"
                      checked={emailRecipients.includes(m.email)}
                      onChange={(e) =>
                        setEmailRecipients((prev) => (e.target.checked ? [...prev, m.email] : prev.filter((r) => r !== m.email)))
                      }
                    />
                    {m.name} <span className="text-text-3">({m.email})</span>
                  </label>
                ))}
                {data.projectMembers.length === 0 && <p className="type-body text-text-3">{t("sprint.emailNoRecipientsHint")}</p>}
              </div>
            </div>
            <label className="flex flex-col gap-1 type-body text-text-2">
              {t("sprint.emailSubjectLabel")}
              <input
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                className="rounded-[7px] border border-border bg-surface px-2 py-1.5"
              />
            </label>
            <label className="flex flex-col gap-1 type-body text-text-2">
              {t("sprint.emailBodyLabel")}
              <textarea
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                rows={8}
                className="rounded-[7px] border border-border bg-surface px-2 py-1.5"
              />
            </label>
            {emailError && <p className="type-body text-danger">{emailError}</p>}
            {emailSentMessage && <p className="type-body text-green">{emailSentMessage}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEmailModalOpen(false)}>
                {t("cancel")}
              </Button>
              <Button onClick={sendEmail} disabled={emailSending || emailRecipients.length === 0}>
                {emailSending ? t("sprint.emailSendingEllipsis") : t("sprint.emailSendButton")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type RoadmapEpic = Awaited<ReturnType<typeof getRoadmapFn>>[number];

function RoadmapTab({ projectId, projectKey }: { projectId: string; projectKey: string }) {
  const { t, i18n } = useTranslation("board");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const [epics, setEpics] = useState<RoadmapEpic[] | null>(null);

  useEffect(() => {
    getRoadmapFn({ data: projectId }).then(setEpics);
  }, [projectId]);

  if (epics === null) return <p className="p-6 type-body text-text-3">{t("loadingEllipsis")}</p>;

  if (epics.length === 0) {
    return (
      <div className="p-6">
        <EmptyStatePanel overline={t("tabs.roadmap")} heading={t("roadmap.noEpicsHeading")} subtext={t("roadmap.noEpicsSubtext")} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 p-6">
      {epics.map((epic) => {
        const pct = epic.childCount === 0 ? 0 : Math.round((epic.doneCount / epic.childCount) * 100);
        return (
          <div key={epic.id} className="rounded-xl border border-border bg-surface p-3.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="font-mono text-[10.5px] text-text-3">
                {projectKey}-{epic.keySeq}
              </span>
              <span className="type-body font-semibold tracking-tight">{epic.title}</span>
              <span className="ml-auto type-label text-text-3">
                {epic.startDate ? new Date(epic.startDate).toLocaleDateString(intlLocale, { day: "numeric", month: "short" }) : "?"} –{" "}
                {epic.dueDate ? new Date(epic.dueDate).toLocaleDateString(intlLocale, { day: "numeric", month: "short" }) : "?"}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--violet)" }} />
            </div>
            <p className="mt-1 type-body text-text-3">
              {t("roadmap.progressSummary", { done: epic.doneCount, total: epic.childCount, pct })}
            </p>
          </div>
        );
      })}
    </div>
  );
}

type AutomationRule = Awaited<ReturnType<typeof listAutomationRulesFn>>[number];

type TriggerType = "issue.created" | "issue.updated" | "issue.transitioned" | "issue.assigned" | "issue.commented";
const ACTION_TYPES = ["add_label", "comment", "transition", "assign", "create_subtask"] as const;

/**
 * v1 scope: one action per rule, no condition builder in the UI (the
 * underlying REST API/engine supports full arrays of both — see
 * packages/core/src/automation.ts — this form just doesn't expose it yet).
 * The "transition" action picks a board column's first mapped status,
 * "assign" only offers users who already appear as an assignee somewhere
 * on this board (getProjectBoardFn doesn't return the full workspace
 * member list), and "create_subtask"'s title is a fixed string, not
 * templated from the triggering issue — all documented v1 limitations.
 */
function AutomationTab({ projectId, data }: { projectId: string; data: BoardData }) {
  const { t } = useTranslation("board");
  const TRIGGER_LABEL: Record<TriggerType, string> = {
    "issue.created": t("automation.triggerCreated"),
    "issue.updated": t("automation.triggerUpdated"),
    "issue.transitioned": t("automation.triggerTransitioned"),
    "issue.assigned": t("automation.triggerAssigned"),
    "issue.commented": t("automation.triggerCommented"),
  };
  const ACTION_LABEL: Record<(typeof ACTION_TYPES)[number], string> = {
    add_label: t("automation.actionAddLabel"),
    comment: t("automation.actionComment"),
    transition: t("automation.actionTransition"),
    assign: t("automation.actionAssign"),
    create_subtask: t("automation.actionCreateSubtask"),
  };
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [runsByRule, setRunsByRule] = useState<Record<string, Awaited<ReturnType<typeof listAutomationRunsFn>>>>({});
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<keyof typeof TRIGGER_LABEL>("issue.transitioned");
  const [actionType, setActionType] = useState<(typeof ACTION_TYPES)[number]>("add_label");
  const [actionLabel, setActionLabel] = useState("");
  const [actionText, setActionText] = useState("");
  const [actionStatusId, setActionStatusId] = useState(data.columns[0]?.statusIds[0] ?? "");
  const [actionAssigneeId, setActionAssigneeId] = useState("");
  const [actionSubtaskTypeId, setActionSubtaskTypeId] = useState(data.issueTypes.find((tp) => tp.isSubtask)?.id ?? data.issueTypes[0]?.id ?? "");
  const [actionSubtaskTitle, setActionSubtaskTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isArmed, arm, disarm } = useConfirmArm();

  async function refresh() {
    setRules(await listAutomationRulesFn({ data: projectId }));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function createRule() {
    if (!name.trim()) return;
    const action =
      actionType === "add_label"
        ? { type: "add_label" as const, label: actionLabel }
        : actionType === "comment"
          ? { type: "comment" as const, text: actionText }
          : actionType === "transition"
            ? { type: "transition" as const, toStatusId: actionStatusId }
            : actionType === "assign"
              ? { type: "assign" as const, assigneeId: actionAssigneeId || null }
              : { type: "create_subtask" as const, typeId: actionSubtaskTypeId, title: actionSubtaskTitle };

    setCreating(true);
    setError(null);
    try {
      await createAutomationRuleFn({ data: { projectId, name: name.trim(), trigger: { type: triggerType }, actions: [action] } });
      setName("");
      setActionLabel("");
      setActionText("");
      setActionSubtaskTitle("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(ruleId: string, enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setAutomationRuleEnabledFn({ data: { ruleId, enabled } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(ruleId: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteAutomationRuleFn({ data: ruleId });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setBusy(false);
    }
  }

  function handleDeleteClick(ruleId: string) {
    if (!isArmed(ruleId)) {
      arm(ruleId);
      return;
    }
    disarm();
    removeRule(ruleId);
  }

  async function toggleRuns(ruleId: string) {
    if (expandedRuleId === ruleId) {
      setExpandedRuleId(null);
      return;
    }
    setExpandedRuleId(ruleId);
    if (!runsByRule[ruleId]) {
      const runs = await listAutomationRunsFn({ data: ruleId });
      setRunsByRule((r) => ({ ...r, [ruleId]: runs }));
    }
  }

  if (rules === null) return <p className="p-6 type-body text-text-3">{t("loadingEllipsis")}</p>;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="mb-3 type-headline">{t("automation.newRuleHeading")}</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11.5px] text-text-3">
            {t("automation.nameLabel")}
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]" />
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-text-3">
            {t("automation.whenLabel")}
            <select value={triggerType} onChange={(e) => setTriggerType(e.target.value as keyof typeof TRIGGER_LABEL)} className="kp-select rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]">
              {Object.entries(TRIGGER_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11.5px] text-text-3">
            {t("automation.thenLabel")}
            <select value={actionType} onChange={(e) => setActionType(e.target.value as (typeof ACTION_TYPES)[number])} className="kp-select rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]">
              {ACTION_TYPES.map((value) => (
                <option key={value} value={value}>
                  {ACTION_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
          {actionType === "add_label" && (
            <input value={actionLabel} onChange={(e) => setActionLabel(e.target.value)} placeholder={t("automation.labelNamePlaceholder")} className="rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]" />
          )}
          {actionType === "comment" && (
            <input value={actionText} onChange={(e) => setActionText(e.target.value)} placeholder={t("automation.commentBodyPlaceholder")} className="rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]" />
          )}
          {actionType === "transition" && (
            <select value={actionStatusId} onChange={(e) => setActionStatusId(e.target.value)} className="kp-select rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]">
              {data.columns.map((c) => (
                <option key={c.id} value={c.statusIds[0] ?? ""}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {actionType === "assign" && (
            <select value={actionAssigneeId} onChange={(e) => setActionAssigneeId(e.target.value)} className="kp-select rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]">
              <option value="">{t("automation.clearAssignmentOption")}</option>
              {data.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          )}
          {actionType === "create_subtask" && (
            <>
              <select value={actionSubtaskTypeId} onChange={(e) => setActionSubtaskTypeId(e.target.value)} className="kp-select rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]">
                {data.issueTypes.map((tp) => (
                  <option key={tp.id} value={tp.id}>
                    {tp.name}
                  </option>
                ))}
              </select>
              <input
                value={actionSubtaskTitle}
                onChange={(e) => setActionSubtaskTitle(e.target.value)}
                placeholder={t("automation.subtaskTitlePlaceholder")}
                className="rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]"
              />
            </>
          )}
          <Button variant="primary" onClick={createRule} disabled={creating || !name.trim()}>
            {t("automation.addRuleButton")}
          </Button>
        </div>
        {error && <p className="mt-2.5 type-body text-danger">{error}</p>}
      </div>

      <div className="flex flex-col gap-2">
        {rules.length === 0 && <p className="type-body text-text-3">{t("automation.noRulesYet")}</p>}
        {rules.map((rule) => (
          <div key={rule.id} className="rounded-xl border border-border bg-surface p-3.5">
            <div className="flex items-center gap-2">
              <span className="type-body font-semibold">{rule.name}</span>
              {rule.dryRun && <Badge>{t("automation.dryRunBadge")}</Badge>}
              <span className="text-[11.5px] text-text-3">
                {TRIGGER_LABEL[(rule.trigger as { type: TriggerType }).type] ?? (rule.trigger as { type: string }).type}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => toggleRuns(rule.id)} className="text-[11.5px] text-text-3 hover:text-text">
                  {t("automation.historyToggle")}
                </button>
                <label className="flex items-center gap-1.5 text-[11.5px] text-text-3">
                  <input type="checkbox" checked={rule.enabled} disabled={busy} onChange={(e) => toggleEnabled(rule.id, e.target.checked)} />
                  {t("automation.activeLabel")}
                </label>
                <Button
                  variant="outline"
                  style={isArmed(rule.id) ? { color: "var(--danger)", borderColor: "var(--danger)" } : undefined}
                  title={isArmed(rule.id) ? t("automation.deleteRuleConfirm") : undefined}
                  onClick={() => handleDeleteClick(rule.id)}
                  disabled={busy}
                >
                  {isArmed(rule.id) ? t("clickAgainToDelete") : t("automation.deleteButton")}
                </Button>
              </div>
            </div>
            {expandedRuleId === rule.id && (
              <div className="mt-2.5 border-t border-border pt-2.5">
                {!runsByRule[rule.id] || runsByRule[rule.id]!.length === 0 ? (
                  <p className="type-body text-text-3">{t("automation.noRunsYet")}</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {runsByRule[rule.id]!.map((run) => (
                      <div key={run.id} className="flex items-center gap-2 type-label text-text-3">
                        <span className="font-mono">{new Date(run.createdAt).toLocaleString()}</span>
                        <Badge>{run.status}</Badge>
                        {run.error && <span className="text-danger">{run.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

type ImportRun = Awaited<ReturnType<typeof listImportRunsFn>>[number];

/**
 * Runs synchronously against a real JIRA instance from this one request —
 * see startJiraImportFn's own doc comment for why. The API token is only
 * ever held in this component's state for the duration of one submit
 * (cleared right after) and never persisted — createImportRun's `config`
 * deliberately excludes it (see packages/db/src/schema/import.ts).
 */
function ImportTab({ projectId, boardId }: { projectId: string; boardId: string }) {
  const { t } = useTranslation("board");
  const IMPORT_RUN_STATUS_LABEL: Record<string, string> = {
    pending: t("importTab.statusPending"),
    running: t("importTab.statusRunning"),
    completed: t("importTab.statusCompleted"),
    failed: t("importTab.statusFailed"),
  };
  const [runs, setRuns] = useState<ImportRun[] | null>(null);
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraApiToken, setJiraApiToken] = useState("");
  const [jql, setJql] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [fetchAttachments, setFetchAttachments] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Awaited<ReturnType<typeof startJiraImportFn>> | null>(null);

  async function refresh() {
    setRuns(await listImportRunsFn({ data: projectId }));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function runImport() {
    if (!jiraBaseUrl.trim() || !jiraEmail.trim() || !jiraApiToken.trim() || !jql.trim()) return;
    setRunning(true);
    setLastResult(null);
    setRunError(null);
    try {
      const result = await startJiraImportFn({
        data: { projectId, boardId, jiraBaseUrl: jiraBaseUrl.trim(), jiraEmail: jiraEmail.trim(), jiraApiToken, jql: jql.trim(), dryRun, fetchAttachments },
      });
      setLastResult(result);
      setJiraApiToken("");
      await refresh();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setRunning(false);
    }
  }

  if (runs === null) return <p className="p-6 type-body text-text-3">{t("loadingEllipsis")}</p>;

  return (
    <div className="grid grid-cols-2 gap-4 p-6">
      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="mb-3 type-label-overline text-text-3">{t("importTab.heading")}</p>
        <div className="flex flex-col gap-2.5">
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-2">{t("importTab.baseUrlLabel")}</span>
            <input
              value={jiraBaseUrl}
              onChange={(e) => setJiraBaseUrl(e.target.value)}
              placeholder={t("importTab.baseUrlPlaceholder")}
              className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-2">{t("importTab.emailLabel")}</span>
            <input value={jiraEmail} onChange={(e) => setJiraEmail(e.target.value)} className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-2">{t("importTab.apiTokenLabel")}</span>
            <input type="password" value={jiraApiToken} onChange={(e) => setJiraApiToken(e.target.value)} className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] text-text-2">{t("importTab.jqlLabel")}</span>
            <input value={jql} onChange={(e) => setJql(e.target.value)} placeholder='project = "DEMO"' className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none" />
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-text-2">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            {t("importTab.dryRunLabel")}
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-text-2">
            <input type="checkbox" checked={fetchAttachments} onChange={(e) => setFetchAttachments(e.target.checked)} />
            {t("importTab.fetchAttachmentsLabel")}
          </label>
          <Button variant="primary" onClick={runImport} disabled={running}>
            {running ? t("importTab.importingEllipsis") : t("importTab.runButton")}
          </Button>
          {runError && <p className="type-body text-danger">{runError}</p>}
          {lastResult?.error && <p className="type-body text-danger">{lastResult.error}</p>}
          {lastResult?.report && (
            <div className="rounded-[9px] border border-border bg-surface-2 p-3 type-body text-text-2">
              <p>
                {t("importTab.resultCreated")} <strong>{lastResult.report.counts.issuesCreated}</strong> · {t("importTab.resultSkipped")} <strong>{lastResult.report.counts.issuesSkipped}</strong> · {t("importTab.resultNewStatuses")}{" "}
                <strong>{lastResult.report.counts.statusesCreated}</strong> · {t("importTab.resultNewTypes")} <strong>{lastResult.report.counts.typesCreated}</strong>
              </p>
              {lastResult.report.errors.length > 0 && <p className="mt-1 text-danger">{t("importTab.resultErrorsNote", { count: lastResult.report.errors.length })}</p>}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-4">
        <p className="mb-3 type-label-overline text-text-3">{t("importTab.historyHeading")}</p>
        <div className="flex flex-col gap-2">
          {runs.length === 0 && <p className="type-body text-text-3">{t("importTab.noImportsYet")}</p>}
          {runs.map((run) => (
            <div key={run.id} className="rounded-[9px] border border-border px-3 py-2 type-body">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {run.source.toUpperCase()} · {IMPORT_RUN_STATUS_LABEL[run.status] ?? run.status}
                </span>
                <span className="text-text-3">{run.dryRun ? t("importTab.dryRunTag") : t("importTab.realTag")}</span>
              </div>
              {run.counts != null && <p className="mt-1 text-text-2">{JSON.stringify(run.counts)}</p>}
              {Array.isArray(run.errors) && run.errors.length > 0 && <p className="mt-1 text-danger">{t("importTab.errorCount", { count: run.errors.length })}</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const CYCLE_OPTIONS: Array<{ value: "1w" | "2w" | "3w" | "4w" | "custom"; labelKey: string }> = [
  { value: "1w", labelKey: "sprint.cycle1w" },
  { value: "2w", labelKey: "sprint.cycle2w" },
  { value: "3w", labelKey: "sprint.cycle3w" },
  { value: "4w", labelKey: "sprint.cycle4w" },
  { value: "custom", labelKey: "sprint.wizardCycleCustom" },
];

function SprintSetupWizard({ boardId, onCreated }: { boardId: string; onCreated: () => void }) {
  const { t } = useTranslation("board");
  const [cycle, setCycle] = useState<"1w" | "2w" | "3w" | "4w" | "custom">("2w");
  const [startingNumber, setStartingNumber] = useState("1");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const number = Number.parseInt(startingNumber, 10);
    if (!Number.isInteger(number) || number < 1) {
      setError(t("sprint.wizardInvalidNumber"));
      return;
    }
    if (cycle === "custom" && (!customStart || !customEnd)) {
      setError(t("sprint.wizardCustomDatesRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createSprintFn({
        data: {
          boardId,
          number,
          cycle,
          startAt: cycle === "custom" ? new Date(customStart) : undefined,
          endAt: cycle === "custom" ? new Date(customEnd) : undefined,
        },
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mx-auto max-w-[480px] rounded-xl border border-border bg-surface p-6">
        <p className="mb-1 type-title">{t("sprint.wizardHeading")}</p>
        <p className="mb-5 type-body text-text-2">{t("sprint.wizardSubtitle")}</p>

        <label className="mb-4 block">
          <span className="mb-1 block text-[12px] text-text-2">{t("sprint.wizardCycleLabel")}</span>
          <select
            value={cycle}
            onChange={(e) => setCycle(e.target.value as typeof cycle)}
            className="kp-select w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
          >
            {CYCLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </label>

        {cycle === "custom" && (
          <div className="mb-4 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] text-text-2">{t("sprint.wizardCustomStartLabel")}</span>
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] text-text-2">{t("sprint.wizardCustomEndLabel")}</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
              />
            </label>
          </div>
        )}

        <label className="mb-5 block">
          <span className="mb-1 block text-[12px] text-text-2">{t("sprint.wizardStartingNumberLabel")}</span>
          <input
            type="number"
            min={1}
            value={startingNumber}
            onChange={(e) => setStartingNumber(e.target.value)}
            className="w-full rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
          />
          <span className="mt-1 block text-[11.5px] text-text-3">{t("sprint.wizardStartingNumberHint")}</span>
        </label>

        {error && <p className="mb-4 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>}

        <Button variant="primary" onClick={submit} disabled={busy}>
          {t("sprint.wizardSubmitButton")}
        </Button>
      </div>
    </div>
  );
}

function BoardView({ data }: { data: BoardData }) {
  const { t } = useTranslation("board");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const usersById = new Map(data.users.map((u) => [u.id, u]));
  const issueTypesById = new Map(data.issueTypes.map((tp) => [tp.id, tp]));
  const priorityLevelsByKey = new Map(data.priorityLevels.map((p) => [p.key, p]));
  const teamId = data.project.teamId ?? "none";

  // "+ add issue" at the bottom of the board's first non-backlog column
  // reuses addIssueToSprint's own Backlog->To Do transition (see
  // packages/core/src/sprint.ts) rather than a separate "target status"
  // concept: create into Backlog like every other new issue, then add it
  // to the active sprint — it lands in the right column on its own.
  const defaultType = data.issueTypes.find((tp) => !tp.isSubtask);
  const backlogStatusId = data.columns.find((c) => c.isBacklog)?.statusIds[0];
  const [addingToBoard, setAddingToBoard] = useState(false);
  const [newBoardIssueTitle, setNewBoardIssueTitle] = useState("");
  const [addBoardIssueError, setAddBoardIssueError] = useState<string | null>(null);

  async function submitBoardIssue() {
    if (!newBoardIssueTitle.trim() || !defaultType || !backlogStatusId || !data.activeSprint) return;
    setPending(true);
    setAddBoardIssueError(null);
    try {
      const created = await createIssueFn({
        data: { projectId: data.project.id, typeId: defaultType.id, statusId: backlogStatusId, title: newBoardIssueTitle.trim() },
      });
      await addIssueToSprintFn({ data: { sprintId: data.activeSprint.id, issueId: created.issueId } });
      setNewBoardIssueTitle("");
      setAddingToBoard(false);
      await router.invalidate();
    } catch (err) {
      setAddBoardIssueError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setPending(false);
    }
  }

  // A keyboard-moved card unmounts from its old column and remounts under a
  // new one once `data` refreshes — React can't preserve focus across that.
  // Track the moved issue's DOM node by id and refocus it once the new data
  // (and the new Card instance) lands, so a multi-hop move stays keyboard-navigable.
  const cardRefs = useRef(new Map<string, HTMLAnchorElement>());
  const pendingFocusId = useRef<string | null>(null);

  function registerCardRef(issueId: string, el: HTMLAnchorElement | null) {
    if (el) cardRefs.current.set(issueId, el);
    else cardRefs.current.delete(issueId);
  }

  useEffect(() => {
    if (pendingFocusId.current) {
      cardRefs.current.get(pendingFocusId.current)?.focus();
      pendingFocusId.current = null;
    }
  }, [data]);

  const activeSprintIssueIds = new Set(data.activeSprintIssueIds);
  const needle = search.trim().toLowerCase();
  const columns = data.columns
    .filter((col) => !col.isBacklog)
    .map((col) => ({ ...col, issues: col.issues.filter((i) => activeSprintIssueIds.has(i.id)) }))
    .map((col) =>
      needle
        ? { ...col, issues: col.issues.filter((i) => i.title.toLowerCase().includes(needle) || `${data.project.key}-${i.keySeq}`.toLowerCase().includes(needle)) }
        : col,
    );

  // Releasing a drag leaves a trailing native click on the dragged card. dnd-kit
  // already swallows it, but with a document-level capture listener that only calls
  // stopPropagation() — enough to keep it away from React (so no handler on the card
  // itself can ever see that click), yet a cancelled-propagation event still runs its
  // default action, and the card is a real <a href>. So the browser navigates on its
  // own and the issue the user only meant to move opens. Capture on `window` runs
  // ahead of dnd-kit's document listener, making this the last point where that
  // default can still be cancelled. Armed by onDragStart, which the sensor's 4px
  // activation distance means only ever fires for a genuine drag, never a click.
  const suppressClickRef = useRef(false);

  function handleDragStart() {
    suppressClickRef.current = true;
  }

  useEffect(() => {
    // A drag that ends without a trailing click would otherwise leave the flag
    // armed and eat the next real click, so every fresh press disarms it.
    function disarm() {
      suppressClickRef.current = false;
    }
    function cancelClickAfterDrag(e: Event) {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      e.preventDefault();
    }
    window.addEventListener("pointerdown", disarm, true);
    window.addEventListener("click", cancelClickAfterDrag, true);
    return () => {
      window.removeEventListener("pointerdown", disarm, true);
      window.removeEventListener("click", cancelClickAfterDrag, true);
    };
  }, []);

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    // Dropping onto a column's empty area moves to the end of that column;
    // dropping onto a specific card inserts before it. Both are encoded as
    // droppable ids so a single handler covers both without extra state.
    const overColumn = columns.find((c) => c.id === overId);
    const overIsCard = columns.some((c) => c.issues.some((i) => i.id === overId));

    let toStatusId: string | undefined;
    let beforeIssueId: string | undefined;
    let afterIssueId: string | undefined;

    if (overColumn) {
      toStatusId = overColumn.statusIds[0];
      afterIssueId = overColumn.issues.at(-1)?.id;
    } else if (overIsCard) {
      const targetColumn = columns.find((c) => c.issues.some((i) => i.id === overId))!;
      toStatusId = targetColumn.statusIds[0];
      beforeIssueId = overId;
    } else {
      return;
    }
    if (!toStatusId) return;

    setPending(true);
    setError(null);
    setAnnouncement(null);
    try {
      await moveIssueFn({ data: { issueId: activeId, toStatusId, beforeIssueId, afterIssueId } });
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setPending(false);
    }
  }

  // Keyboard alternative to pointer drag-and-drop: rather than wiring up
  // dnd-kit's own KeyboardSensor (whose default coordinate getter nudges by
  // a fixed pixel step — clumsy for jumping between ~274px-wide columns),
  // a focused card's own Left/Right arrow keys move it deterministically to
  // the adjacent column. Simpler, and just as accessible.
  async function moveToAdjacentColumn(issueId: string, fromColumnId: string, direction: "prev" | "next") {
    const idx = columns.findIndex((c) => c.id === fromColumnId);
    const target = columns[direction === "prev" ? idx - 1 : idx + 1];
    if (!target) return;
    const toStatusId = target.statusIds[0];
    if (!toStatusId) return;

    setPending(true);
    setError(null);
    setAnnouncement(null);
    try {
      await moveIssueFn({ data: { issueId, toStatusId, afterIssueId: target.issues.at(-1)?.id } });
      pendingFocusId.current = issueId;
      await router.invalidate();
      setAnnouncement(t("boardView.movedToColumn", { column: target.name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setPending(false);
    }
  }

  if (!data.activeSprint) {
    return (
      <div className="p-6">
        <EmptyStatePanel overline={t("tabs.board")} heading={t("sprint.boardEmptyHeading")} subtext={t("sprint.boardEmptySubtext")} />
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2.5">
          <Badge tone="indigo">
            {t("boardView.activeSprintBadge", { number: data.activeSprint.number, name: data.activeSprint.name })}
          </Badge>
          <div className="flex w-[190px] items-center gap-1.5 rounded-[7px] border border-border bg-surface px-2 py-1.5">
            <Search size={14} strokeWidth={1.75} className="flex-none text-text-3" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("boardView.searchPlaceholder")}
              className="min-w-0 flex-1 border-none bg-transparent text-[12.5px] outline-none placeholder:text-text-3"
            />
          </div>
          <div className="ml-auto flex items-center gap-2 type-body" aria-live="polite">
            {pending && <span className="text-text-3">{t("savingEllipsis")}</span>}
            {!pending && error && <span className="text-danger">{error}</span>}
            {!pending && !error && announcement && <span className="text-text-3">{announcement}</span>}
          </div>
        </div>

        <p id="kanban-keyboard-hint" className="sr-only">
          {t("boardView.keyboardHint")}
        </p>

        <div
          className="flex min-h-[calc(100vh-200px)] items-start gap-4 overflow-x-auto px-6 pb-7 pt-4"
          style={{
            backgroundImage: "radial-gradient(var(--grid) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        >
          {columns.map((col, index) => (
            <Column
              key={col.id}
              column={col}
              teamId={teamId}
              projectKey={data.project.key}
              issueTypesById={issueTypesById}
              usersById={usersById}
              priorityLevelsByKey={priorityLevelsByKey}
              visibleProperties={data.propertyDefinitions.filter((p) => p.visibleOnCard)}
              onMoveToAdjacentColumn={moveToAdjacentColumn}
              registerCardRef={registerCardRef}
              showAddIssue={index === 0}
              addingIssue={addingToBoard}
              newIssueTitle={newBoardIssueTitle}
              onNewIssueTitleChange={setNewBoardIssueTitle}
              onStartAddIssue={() => setAddingToBoard(true)}
              onSubmitAddIssue={submitBoardIssue}
              onCancelAddIssue={() => { setAddingToBoard(false); setAddBoardIssueError(null); }}
              addIssueError={addBoardIssueError}
            />
          ))}
        </div>
      </div>
    </DndContext>
  );
}

function Column({
  column,
  teamId,
  projectKey,
  issueTypesById,
  usersById,
  priorityLevelsByKey,
  visibleProperties,
  onMoveToAdjacentColumn,
  registerCardRef,
  showAddIssue,
  addingIssue,
  newIssueTitle,
  onNewIssueTitleChange,
  onStartAddIssue,
  onSubmitAddIssue,
  onCancelAddIssue,
  addIssueError,
}: {
  column: BoardData["columns"][number];
  teamId: string;
  projectKey: string;
  issueTypesById: Map<string, BoardData["issueTypes"][number]>;
  usersById: Map<string, BoardData["users"][number]>;
  priorityLevelsByKey: Map<string, BoardData["priorityLevels"][number]>;
  visibleProperties: BoardData["propertyDefinitions"];
  onMoveToAdjacentColumn: (issueId: string, fromColumnId: string, direction: "prev" | "next") => void;
  registerCardRef: (issueId: string, el: HTMLAnchorElement | null) => void;
  showAddIssue: boolean;
  addingIssue: boolean;
  newIssueTitle: string;
  onNewIssueTitleChange: (value: string) => void;
  onStartAddIssue: () => void;
  onSubmitAddIssue: () => void;
  onCancelAddIssue: () => void;
  addIssueError: string | null;
}) {
  const { t } = useTranslation("board");
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <div className="flex w-[274px] flex-none flex-col gap-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: column.color }} />
        <span className="type-body font-semibold tracking-tight">{column.name}</span>
        <span className="type-label text-text-3">{column.issues.length}</span>
        {column.isBacklog && <Badge>{t("fixedBadge")}</Badge>}
        {column.wipLimit != null && column.issues.length > column.wipLimit && (
          <span className="ml-auto type-label font-semibold text-amber">
            {column.issues.length}/{column.wipLimit}
          </span>
        )}
      </div>

      <div
        ref={setNodeRef}
        className="flex min-h-[40px] flex-col gap-1.5 rounded-[9px]"
        style={isOver ? { background: "var(--surface-3)" } : undefined}
      >
        {column.issues.length === 0 && (
          <p className="rounded-[9px] border border-dashed border-border px-2.5 py-3 text-center type-body text-text-3">
            {t("boardView.columnEmpty")}
          </p>
        )}
        {column.issues.map((issue) => (
          <Card
            key={issue.id}
            issue={issue}
            teamId={teamId}
            projectKey={projectKey}
            columnId={column.id}
            issueTypesById={issueTypesById}
            usersById={usersById}
            priorityLevelsByKey={priorityLevelsByKey}
            visibleProperties={visibleProperties}
            onMoveToAdjacentColumn={onMoveToAdjacentColumn}
            registerCardRef={registerCardRef}
          />
        ))}
        {showAddIssue && (
          addingIssue ? (
            <div className="flex flex-col gap-1.5">
              <input
                autoFocus
                value={newIssueTitle}
                onChange={(e) => onNewIssueTitleChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmitAddIssue();
                  if (e.key === "Escape") onCancelAddIssue();
                }}
                placeholder={t("header.newIssuePlaceholder")}
                className="rounded-[7px] border border-border-2 bg-surface px-2 py-1.5 text-[12.5px] outline-none"
              />
              <div className="flex gap-1.5">
                <Button variant="primary" onClick={onSubmitAddIssue}>
                  {t("save")}
                </Button>
                <Button variant="outline" onClick={onCancelAddIssue}>
                  {t("cancel")}
                </Button>
              </div>
              {addIssueError && <p className="type-body text-danger">{addIssueError}</p>}
            </div>
          ) : (
            <button
              type="button"
              onClick={onStartAddIssue}
              className="rounded-[9px] border border-dashed border-border px-2.5 py-2 text-left type-body text-text-3 hover:border-border-2 hover:text-text-2"
            >
              + {t("boardView.addIssueButton")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function formatPropertyValue(type: string, value: unknown, intlLocale: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (type === "checkbox") return value ? "✓" : null;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : null;
  if (type === "date") {
    const d = new Date(value as string);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString(intlLocale, { day: "numeric", month: "short" });
  }
  return String(value);
}

function Card({
  issue,
  teamId,
  projectKey,
  columnId,
  issueTypesById,
  usersById,
  priorityLevelsByKey,
  visibleProperties,
  onMoveToAdjacentColumn,
  registerCardRef,
}: {
  issue: BoardData["columns"][number]["issues"][number];
  teamId: string;
  projectKey: string;
  columnId: string;
  issueTypesById: Map<string, BoardData["issueTypes"][number]>;
  usersById: Map<string, BoardData["users"][number]>;
  priorityLevelsByKey: Map<string, BoardData["priorityLevels"][number]>;
  visibleProperties: BoardData["propertyDefinitions"];
  onMoveToAdjacentColumn: (issueId: string, fromColumnId: string, direction: "prev" | "next") => void;
  registerCardRef: (issueId: string, el: HTMLAnchorElement | null) => void;
}) {
  const { i18n } = useTranslation("board");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const { listeners, setNodeRef, transform, isDragging } = useDraggable({ id: issue.id });

  function setRefs(el: HTMLAnchorElement | null) {
    setNodeRef(el);
    registerCardRef(issue.id, el);
  }
  const type = issueTypesById.get(issue.typeId);
  const assignee = issue.assigneeId ? usersById.get(issue.assigneeId) : undefined;
  const customFields = (issue.customFields ?? {}) as Record<string, unknown>;
  const propertyChips = visibleProperties
    .map((p) => ({ def: p, text: formatPropertyValue(p.type, customFields[p.key], intlLocale) }))
    .filter((c): c is { def: (typeof visibleProperties)[number]; text: string } => c.text !== null);

  function handleKeyDown(e: KeyboardEvent<HTMLAnchorElement>) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onMoveToAdjacentColumn(issue.id, columnId, "prev");
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onMoveToAdjacentColumn(issue.id, columnId, "next");
    }
  }

  return (
    <Link
      to="/issues/$teamId/$projectKey/$issueKeySeq"
      params={{ teamId, projectKey, issueKeySeq: String(issue.keySeq) }}
      ref={setRefs}
      {...listeners}
      onKeyDown={handleKeyDown}
      aria-describedby="kanban-keyboard-hint"
      aria-keyshortcuts="ArrowLeft ArrowRight"
      className="block w-full rounded-[10px] border border-border bg-surface p-3 text-left hover:border-border-2"
      style={{
        opacity: isDragging ? 0.4 : 1,
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
      }}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="type-label text-text-3">
          {projectKey}-{issue.keySeq}
        </span>
        {type && (
          <span
            className="rounded px-1 py-px text-[9.5px] font-bold uppercase tracking-[0.03em]"
            style={{ background: "var(--surface-3)", color: "var(--text-2)" }}
          >
            {type.name}
          </span>
        )}
      </div>
      <p className="mb-2 line-clamp-2 type-body font-medium leading-snug tracking-tight">{issue.title}</p>
      {issue.labels.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {issue.labels.slice(0, 3).map((label) => (
            <span key={label} className="rounded bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium text-text-2">
              {label}
            </span>
          ))}
          {issue.labels.length > 3 && (
            <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium text-text-3">
              +{issue.labels.length - 3}
            </span>
          )}
        </div>
      )}
      {propertyChips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {propertyChips.slice(0, 3).map(({ def, text }) => (
            <span
              key={def.id}
              title={def.name}
              className="rounded bg-indigo-soft px-1.5 py-0.5 text-[10.5px] font-medium text-indigo"
            >
              {def.name}: {text}
            </span>
          ))}
          {propertyChips.length > 3 && (
            <span className="rounded bg-indigo-soft px-1.5 py-0.5 text-[10.5px] font-medium text-indigo">
              +{propertyChips.length - 3}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span
          className="inline-flex flex-none items-center gap-1 text-[10px] font-medium"
          style={{ color: priorityLevelsByKey.get(issue.priority)?.color }}
        >
          <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: priorityLevelsByKey.get(issue.priority)?.color }} />
          {priorityLevelsByKey.get(issue.priority)?.name ?? issue.priority}
        </span>
        {assignee && <Avatar initials={initialsOf(assignee.name)} />}
        {issue.dueDate && (
          <span className="type-label text-text-3">
            {new Date(issue.dueDate).toLocaleDateString(intlLocale, { day: "numeric", month: "short" })}
          </span>
        )}
        {issue.storyPoints != null && (
          <span className="ml-auto rounded bg-surface-3 px-1 py-px type-label font-semibold text-text-3">
            {issue.storyPoints}
          </span>
        )}
      </div>
    </Link>
  );
}
