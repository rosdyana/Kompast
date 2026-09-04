import { createFileRoute } from "@tanstack/react-router";
import { getBurndown, getCumulativeFlow, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveSprint } from "@/lib/api-resolvers";

/**
 * Historical trend data — separate from GET /sprints/{id}'s live scope/
 * completion summary, since burndown/CFD reconstruct a day-by-day series
 * from issue_history (there's no nightly snapshot cron — see
 * packages/core/src/sprint-report.ts) and are more expensive to compute.
 */
export const Route = createFileRoute("/api/v1/sprints/$sprintId/report")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const sprint = await resolveSprint(tx, ctx.organizationId, params.sprintId);
            const [burndown, cumulativeFlow] = await Promise.all([getBurndown(tx, sprint.id), getCumulativeFlow(tx, sprint.id)]);
            return jsonResponse({ burndown, cumulativeFlow });
          });
        }),
    },
  },
});
