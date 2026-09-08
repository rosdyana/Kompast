import { createFileRoute, useRouter, useNavigate, Link } from "@tanstack/react-router";
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
} from "@/lib/server-fns/sprints";
import { getRoadmapFn } from "@/lib/server-fns/roadmap";
import { listAutomationRulesFn, listAutomationRunsFn, createAutomationRuleFn, setAutomationRuleEnabledFn, deleteAutomationRuleFn } from "@/lib/server-fns/automation";
import { TableView } from "@/components/board/TableView";
import { ProjectSettingsTab } from "@/components/board/ProjectSettingsTab";
import { DocsTree } from "@/components/docs/DocsTree";

export const Route = createFileRoute("/_app/projects/$projectKey")({
  loader: ({ params }) => getProjectBoardFn({ data: params.projectKey }),
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

  const defaultType = data.issueTypes.find((tp) => !tp.isSubtask);
  const backlogColumn = data.columns.find((c) => c.isBacklog) ?? data.columns[0];

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
        </div>
        <Tabs items={viewTabs} active={view} onChange={setView} className="mt-4" />
        {newIssueError && (
          <p className="mb-4 mt-2 rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{newIssueError}</p>
        )}
      </div>

      {view === "board" && (
        data.hasAnySprint
          ? <BoardView data={data} />
          : <SprintSetupWizard boardId={data.board.id} onCreated={() => { router.invalidate(); setView("backlog"); }} />
      )}
      {view === "backlog" && (
        data.hasAnySprint
          ? <BacklogTab projectId={data.project.id} boardId={data.board.id} />
          : <SprintSetupWizard boardId={data.board.id} onCreated={() => router.invalidate()} />
      )}
      {view === "table" && <TableView data={data} />}
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

const PRIORITY_COLOR: Record<string, string> = {
  highest: "var(--danger)",
  high: "var(--amber)",
  medium: "var(--text-3)",
  low: "var(--text-3)",
  lowest: "var(--text-3)",
};

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

function BacklogTab({ projectId, boardId }: { projectId: string; boardId: string }) {
  const { t } = useTranslation("board");
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
  }, [projectId, boardId]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
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

  async function saveRename(sprintId: string) {
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

  function SprintHeading({ sprint }: { sprint: SprintSummary }) {
    if (renamingId === sprint.id) {
      return (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={() => saveRename(sprint.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveRename(sprint.id);
            if (e.key === "Escape") setRenamingId(null);
          }}
          className="rounded-[7px] border border-border-2 bg-surface px-2 py-1 text-[13px] outline-none"
        />
      );
    }
    return (
      <button
        type="button"
        onClick={() => { setRenamingId(sprint.id); setRenameValue(sprint.name); }}
        className="type-label-overline text-text-3 hover:text-text-2"
        title={t("sprint.renameHint")}
      >
        {sprint.name}
      </button>
    );
  }

  function SprintSection({ sprint }: { sprint: SprintSummary }) {
    const detail = details[sprint.id];
    return (
      <div className="rounded-xl border border-border bg-surface p-3">
        <div className="mb-2 flex items-center justify-between">
          <SprintHeading sprint={sprint} />
          {sprint.state === "future" && (
            <Button variant="outline" disabled={busy} onClick={() => handleStart(sprint.id)}>
              {t("sprint.start")}
            </Button>
          )}
          {sprint.state === "active" && (
            <Button variant="outline" disabled={busy} onClick={() => handleComplete(sprint.id)}>
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
            <div key={issue.id} className="flex items-center justify-between rounded-[9px] border border-border px-2 py-1.5">
              <span className="truncate type-body">{issue.title}</span>
              <Button variant="outline" disabled={busy} onClick={() => removeFromSprint(issue.id)}>
                {t("sprint.removeButton")}
              </Button>
            </div>
          ))}
        </div>
        {sprint.state === "active" && (
          <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex items-center justify-between">
              <p className="type-label-overline text-text-3">{t("sprint.aiSummaryHeading")}</p>
              <Button variant="outline" onClick={() => generateAiSummary(sprint.id)} disabled={aiBusy}>
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

  return (
    <div className="flex flex-col gap-4 p-6">
      {error && <p className="rounded-[7px] border border-danger-soft bg-danger-soft px-3 py-2 type-body text-danger">{error}</p>}

      {activeSprint && (
        <div>
          <p className="mb-2 type-label-overline text-text-3">{t("sprint.activeSectionHeading")}</p>
          <SprintSection sprint={activeSprint} />
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
            <SprintSection key={s.id} sprint={s} />
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-3">
        <p className="mb-2 type-label-overline text-text-3">{t("sprint.backlogHeading")}</p>
        <div className="flex flex-col gap-1.5">
          {backlog.length === 0 && <p className="type-body text-text-3">{t("sprint.backlogEmpty")}</p>}
          {backlog.map((issue) => (
            <div key={issue.id} className="flex items-center justify-between rounded-[9px] border border-border px-2 py-1.5">
              <span className="truncate type-body">{issue.title}</span>
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
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Reuses TableView verbatim (same grouping/sort/inline links, same
 * project-level saved-view config) filtered down to just this sprint's
 * issues — the plan's "sprint review = the sprint's view in table mode
 * with grouping" ask, without a separate saved_view row per sprint (one
 * project-level table preference is shared across the Tabel tab and
 * every sprint's review here, a deliberate simplification). Cells are
 * still read-only (linking out to the issue detail page to edit) — full
 * inline-cell editing is a separate, larger gap that applies to the
 * whole table view feature, not unique to sprint review.
 */
function SprintReviewTable({ boardData, sprintIssueIds }: { boardData: BoardData; sprintIssueIds: Set<string> }) {
  const filtered: BoardData = { ...boardData, columns: boardData.columns.map((c) => ({ ...c, issues: c.issues.filter((i) => sprintIssueIds.has(i.id)) })) };
  return <TableView data={filtered} />;
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
    const overColumn = data.columns.find((c) => c.id === overId);
    const overIsCard = data.columns.some((c) => c.issues.some((i) => i.id === overId));

    let toStatusId: string | undefined;
    let beforeIssueId: string | undefined;
    let afterIssueId: string | undefined;

    if (overColumn) {
      toStatusId = overColumn.statusIds[0];
      afterIssueId = overColumn.issues.at(-1)?.id;
    } else if (overIsCard) {
      const targetColumn = data.columns.find((c) => c.issues.some((i) => i.id === overId))!;
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
    const idx = data.columns.findIndex((c) => c.id === fromColumnId);
    const target = data.columns[direction === "prev" ? idx - 1 : idx + 1];
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
          {columns.map((col) => (
            <Column
              key={col.id}
              column={col}
              projectKey={data.project.key}
              issueTypesById={issueTypesById}
              usersById={usersById}
              visibleProperties={data.propertyDefinitions.filter((p) => p.visibleOnCard)}
              onMoveToAdjacentColumn={moveToAdjacentColumn}
              registerCardRef={registerCardRef}
            />
          ))}
        </div>
      </div>
    </DndContext>
  );
}

function Column({
  column,
  projectKey,
  issueTypesById,
  usersById,
  visibleProperties,
  onMoveToAdjacentColumn,
  registerCardRef,
}: {
  column: BoardData["columns"][number];
  projectKey: string;
  issueTypesById: Map<string, BoardData["issueTypes"][number]>;
  usersById: Map<string, BoardData["users"][number]>;
  visibleProperties: BoardData["propertyDefinitions"];
  onMoveToAdjacentColumn: (issueId: string, fromColumnId: string, direction: "prev" | "next") => void;
  registerCardRef: (issueId: string, el: HTMLAnchorElement | null) => void;
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
            projectKey={projectKey}
            columnId={column.id}
            issueTypesById={issueTypesById}
            usersById={usersById}
            visibleProperties={visibleProperties}
            onMoveToAdjacentColumn={onMoveToAdjacentColumn}
            registerCardRef={registerCardRef}
          />
        ))}
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
  projectKey,
  columnId,
  issueTypesById,
  usersById,
  visibleProperties,
  onMoveToAdjacentColumn,
  registerCardRef,
}: {
  issue: BoardData["columns"][number]["issues"][number];
  projectKey: string;
  columnId: string;
  issueTypesById: Map<string, BoardData["issueTypes"][number]>;
  usersById: Map<string, BoardData["users"][number]>;
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
      to="/issues/$projectKey/$issueKeySeq"
      params={{ projectKey, issueKeySeq: String(issue.keySeq) }}
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
          className="inline-flex flex-none items-center gap-1 text-[10px] font-medium capitalize"
          style={{ color: PRIORITY_COLOR[issue.priority] }}
        >
          <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: PRIORITY_COLOR[issue.priority] }} />
          {issue.priority}
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
