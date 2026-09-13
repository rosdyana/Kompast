import { createFileRoute } from "@tanstack/react-router";
import { getWorkflow, getWorkflowRun, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth, ApiError } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";

export const Route = createFileRoute("/api/v1/automation/workflows/$workflowId/runs/$runId")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const workflow = await getWorkflow(tx, params.workflowId);
            if (!workflow) throw new ApiError(404, "Not Found", `Workflow ${params.workflowId} not found`);
            const run = await getWorkflowRun(tx, params.runId);
            if (!run || run.workflowId !== params.workflowId) throw new ApiError(404, "Not Found", `Run ${params.runId} not found`);
            return jsonResponse({ data: run });
          });
        }),
    },
  },
});
