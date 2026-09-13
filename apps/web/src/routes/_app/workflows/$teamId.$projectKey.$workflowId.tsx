import { createFileRoute, notFound } from "@tanstack/react-router";
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

  return (
    <div className="h-[calc(100vh-var(--topbar-h,0px))] w-full">
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
