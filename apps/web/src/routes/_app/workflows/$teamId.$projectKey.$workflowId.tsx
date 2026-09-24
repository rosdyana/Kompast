import { createFileRoute, notFound, useLoaderData } from "@tanstack/react-router";
import { useTranslation } from "@kompast/i18n";
import { Zap } from "lucide-react";
import { usePageChrome } from "@/components/shell/WorkbenchContext";
import { ProjectIcon } from "@/components/shell/ProjectIcon";
import { getWorkflowFn } from "@/lib/server-fns/automation-workflows";
import { WorkflowCanvas } from "@/components/automation-workflow/WorkflowCanvas";

export const Route = createFileRoute("/_app/workflows/$teamId/$projectKey/$workflowId")({
  loader: async ({ params }) => {
    const workflow = await getWorkflowFn({ data: params.workflowId });
    if (!workflow) throw notFound();
    return { workflow };
  },
  component: WorkflowCanvasPage,
});

function WorkflowCanvasPage() {
  const { teamId, projectKey } = Route.useParams();
  const { workflow } = Route.useLoaderData();
  const { t } = useTranslation("board");
  const shell = useLoaderData({ from: "/_app" });
  const project = shell.projects.find((p) => p.key === projectKey && (p.teamId ?? "none") === teamId);

  usePageChrome(
    {
      crumbs: [
        {
          label: project?.name ?? projectKey,
          icon: <ProjectIcon projectKey={projectKey} size={16} />,
          link: { to: "/projects/$teamId/$projectKey", params: { teamId, projectKey }, search: { tab: "backlog" } },
        },
        {
          label: t("tabs.automation"),
          icon: <Zap size={14} className="text-text-3" />,
          link: { to: "/projects/$teamId/$projectKey", params: { teamId, projectKey }, search: { tab: "automation" } },
        },
        { label: workflow.name },
      ],
    },
    [teamId, projectKey, project?.name, workflow.name],
  );

  return (
    <div className="h-full w-full">
      <WorkflowCanvas
        workflowId={workflow.id}
        projectId={workflow.projectId}
        teamId={teamId}
        projectKey={projectKey}
        initialName={workflow.name}
        initialEnabled={workflow.enabled}
        initialDryRun={workflow.dryRun}
        initialNodes={workflow.nodes as never}
        initialEdges={workflow.edges as never}
      />
    </div>
  );
}
