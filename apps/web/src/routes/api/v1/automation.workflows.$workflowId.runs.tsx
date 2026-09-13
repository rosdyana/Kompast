import { createFileRoute } from "@tanstack/react-router";
import { listWorkflowRuns, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";

export const Route = createFileRoute("/api/v1/automation/workflows/$workflowId/runs")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const runs = await listWorkflowRuns(tx, params.workflowId);
            return jsonResponse({ data: runs });
          });
        }),
    },
  },
});
