import { createFileRoute, useRouter, useNavigate, useLoaderData } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Download, FileText, Inbox, KanbanSquare, Map as MapIcon, Plus, Settings, Table2, Zap } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Tabs } from "@kompast/ui/Tabs";
import { EmptyState, SkeletonRows } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import { getProjectBoardFn } from "@/lib/server-fns/projects";
import { listProjectPagesFn } from "@/lib/server-fns/pages";
import { DocsTree } from "@/components/docs/DocsTree";
import { ProjectSettingsTab } from "@/components/board/ProjectSettingsTab";
import { WorkflowsListTab } from "@/components/automation-workflow/WorkflowsListTab";
import { BacklogView } from "@/components/board/BacklogView";
import { KanbanBoard } from "@/components/board/KanbanBoard";
import { RoadmapView } from "@/components/board/RoadmapView";
import { ImportView } from "@/components/board/ImportView";
import { SprintHub } from "@/components/board/SprintHub";
import { SprintSetupWizard } from "@/components/board/SprintSetupWizard";
import { ProjectIcon } from "@/components/shell/ProjectIcon";
import { usePageChrome, useWorkbench } from "@/components/shell/WorkbenchContext";

const VIEW_KEYS = ["backlog", "board", "table", "roadmap", "docs", "automation", "import", "settings"] as const;
type ViewKey = (typeof VIEW_KEYS)[number];

export const Route = createFileRoute("/_app/projects/$teamId/$projectKey")({
  // The tab lives in the URL (not local state) so it survives a full
  // navigation away and back — e.g. opening an issue from the Board tab and
  // hitting "back" needs to land on Board again, not reset to the default.
  validateSearch: (search: Record<string, unknown>): { tab?: ViewKey } => ({
    tab: VIEW_KEYS.includes(search.tab as ViewKey) ? (search.tab as ViewKey) : undefined,
  }),
  loader: ({ params }) => getProjectBoardFn({ data: { teamId: params.teamId, projectKey: params.projectKey } }),
  component: ProjectPage,
});

function ProjectPage() {
  const { t } = useTranslation(["board", "nav"]);
  const data = Route.useLoaderData();
  const shell = useLoaderData({ from: "/_app" });
  const router = useRouter();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { openCreateIssue } = useWorkbench();
  const requested = tab ?? "backlog";
  // A non-admin who follows a ?tab=settings link lands on Backlog instead of a blank page.
  const view: ViewKey = requested === "settings" && !data.canManageProject ? "backlog" : requested;
  const [backlogKey, setBacklogKey] = useState(0);

  const teamId = data.project.teamId ?? "none";
  const team = shell.teams.find((tm) => tm.id === data.project.teamId);
  const epicType = data.issueTypes.find((tp) => tp.hierarchyLevel === 0);
  const issueCount = data.columns.reduce((n, c) => n + c.issues.length, 0);

  const iconProps = { size: 15, strokeWidth: 1.75 };
  const viewTabs = [
    { key: "backlog", label: t("tabs.backlog"), icon: <Inbox {...iconProps} /> },
    { key: "board", label: t("tabs.board"), icon: <KanbanSquare {...iconProps} /> },
    { key: "table", label: t("tabs.table"), icon: <Table2 {...iconProps} /> },
    { key: "roadmap", label: t("tabs.roadmap"), icon: <MapIcon {...iconProps} /> },
    { key: "docs", label: t("tabs.docs"), icon: <FileText {...iconProps} /> },
    { key: "automation", label: t("tabs.automation"), icon: <Zap {...iconProps} /> },
    { key: "import", label: t("tabs.import"), icon: <Download {...iconProps} /> },
    ...(data.canManageProject ? [{ key: "settings", label: t("tabs.settings"), icon: <Settings {...iconProps} /> }] : []),
  ];
  const viewLabel = viewTabs.find((v) => v.key === view)?.label ?? "";

  usePageChrome(
    {
      crumbs: [
        { label: team?.name ?? t("header.breadcrumbProjects") },
        {
          label: data.project.name,
          icon: <ProjectIcon projectKey={data.project.key} size={16} />,
          link: { to: "/projects/$teamId/$projectKey", params: { teamId, projectKey: data.project.key }, search: { tab: "backlog" } },
        },
        { label: viewLabel },
      ],
    },
    [data.project.id, data.project.name, team?.name, viewLabel],
  );

  function setView(key: string) {
    navigate({ search: { tab: key as ViewKey } });
  }

  function createIssue() {
    openCreateIssue({
      projectId: data.project.id,
      sprintId: view === "board" ? data.activeSprint?.id : undefined,
      onCreated: () => setBacklogKey((k) => k + 1),
    });
  }

  const needsSprint = (view === "board" || view === "backlog") && !data.hasAnySprint;

  return (
    <div className="flex min-h-full flex-col">
      <div className="px-4 pt-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <ProjectIcon projectKey={data.project.key} size={32} className="rounded-[7px]" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate type-title">{data.project.name}</h1>
            <p className="type-small text-text-3">
              <span className="type-key">{data.project.key}</span> · {t("header.ticketCount", { count: issueCount })}
            </p>
          </div>
          <Button variant="primary" onClick={createIssue}>
            <Plus size={15} strokeWidth={2.25} />
            {t("header.createIssue")}
          </Button>
        </div>
        <Tabs items={viewTabs} active={view} onChange={setView} className="-mx-1 mt-3 border-b border-border" />
      </div>

      <div className="min-h-0 flex-1">
        {needsSprint && (
          <SprintSetupWizard
            boardId={data.board.id}
            onCreated={async () => {
              await router.invalidate();
              setView("backlog");
            }}
          />
        )}
        {view === "backlog" && data.hasAnySprint && <BacklogView key={backlogKey} data={data} teamId={teamId} />}
        {view === "board" && data.hasAnySprint && <KanbanBoard data={data} />}
        {view === "table" && <SprintHub boardId={data.board.id} data={data} />}
        {view === "roadmap" && <RoadmapView projectId={data.project.id} projectKey={data.project.key} teamId={teamId} epicTypeId={epicType?.id} />}
        {view === "docs" && <ProjectDocsTab projectId={data.project.id} />}
        {view === "automation" && (
          <div className="px-4 pb-12 pt-4 sm:px-6">
            <WorkflowsListTab projectId={data.project.id} teamId={teamId} projectKey={data.project.key} />
          </div>
        )}
        {view === "import" && <ImportView projectId={data.project.id} boardId={data.board.id} />}
        {view === "settings" && data.canManageProject && <ProjectSettingsTab data={data} />}
      </div>
    </div>
  );
}

function ProjectDocsTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation("board");
  const { createPage } = useWorkbench();
  const [pages, setPages] = useState<Awaited<ReturnType<typeof listProjectPagesFn>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjectPagesFn({ data: projectId })
      .then(setPages)
      .catch((err) => setError(err instanceof Error ? err.message : t("genericError")));
  }, [projectId, t]);

  const newPage = () => createPage({ projectId });

  return (
    <div className="mx-auto w-full max-w-[880px] px-4 pb-12 pt-5 sm:px-6">
      <div className="mb-4 flex items-center gap-3">
        <p className="flex-1 type-small text-text-2">{t("docsTab.subtitle")}</p>
        <Button variant="primary" size="sm" onClick={newPage}>
          <Plus size={15} /> {t("docsTab.newPageButton")}
        </Button>
      </div>
      {error && <p className="mb-4 rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{error}</p>}
      {pages === null ? (
        !error && <SkeletonRows rows={4} />
      ) : pages.length === 0 ? (
        <EmptyState
          icon={<FileText size={18} />}
          title={t("docsTab.emptyTitle")}
          description={t("docsTab.emptyState")}
          action={
            <Button variant="primary" onClick={newPage}>
              <Plus size={15} /> {t("docsTab.newPageButton")}
            </Button>
          }
        />
      ) : (
        <div className="rounded-[10px] border border-border bg-surface p-1.5">
          <DocsTree pages={pages} onAddChild={(parentPageId) => createPage({ parentPageId, projectId })} />
        </div>
      )}
    </div>
  );
}
