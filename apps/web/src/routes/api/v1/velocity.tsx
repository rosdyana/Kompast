import { createFileRoute } from "@tanstack/react-router";
import { getVelocityHistory, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth, ApiError } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveProject, resolveBoardForProject } from "@/lib/api-resolvers";

export const Route = createFileRoute("/api/v1/velocity")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          const url = new URL(request.url);
          const projectKey = url.searchParams.get("projectKey");
          if (!projectKey) throw new ApiError(400, "Bad Request", "projectKey query param is required");

          return withAuthorizedTenant(ctx, async (tx) => {
            const project = await resolveProject(tx, ctx.organizationId, projectKey);
            const board = await resolveBoardForProject(tx, project.id);
            const history = await getVelocityHistory(tx, board.id);
            return jsonResponse({ data: history });
          });
        }),
    },
  },
});
