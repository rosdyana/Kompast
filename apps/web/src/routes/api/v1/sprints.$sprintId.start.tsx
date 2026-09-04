import { createFileRoute } from "@tanstack/react-router";
import { startSprint, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveSprint } from "@/lib/api-resolvers";

export const Route = createFileRoute("/api/v1/sprints/$sprintId/start")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "sprints:write", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const sprint = await resolveSprint(tx, ctx.organizationId, params.sprintId);
            await startSprint(tx, { sprintId: sprint.id, actorId: ctx.userId });
            return jsonResponse({ ok: true });
          });
        }),
    },
  },
});
