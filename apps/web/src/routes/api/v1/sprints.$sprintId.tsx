import { createFileRoute } from "@tanstack/react-router";
import { getSprintReport, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveSprint } from "@/lib/api-resolvers";

export const Route = createFileRoute("/api/v1/sprints/$sprintId")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const sprint = await resolveSprint(tx, ctx.organizationId, params.sprintId);
            const report = await getSprintReport(tx, sprint.id);
            return jsonResponse({
              id: sprint.id,
              name: sprint.name,
              goal: sprint.goal,
              state: sprint.state,
              cycle: sprint.cycle,
              startAt: sprint.startAt?.toISOString() ?? null,
              endAt: sprint.endAt?.toISOString() ?? null,
              capacityPoints: sprint.capacityPoints,
              report,
            });
          });
        }),
    },
  },
});
