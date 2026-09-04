import { createFileRoute } from "@tanstack/react-router";
import { getEpicRoadmap, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth, ApiError } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveProject } from "@/lib/api-resolvers";

export const Route = createFileRoute("/api/v1/roadmap")({
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
            const epics = await getEpicRoadmap(tx, project.id);
            return jsonResponse({
              data: epics.map((e) => ({
                key: `${project.key}-${e.keySeq}`,
                title: e.title,
                startDate: e.startDate?.toISOString() ?? null,
                dueDate: e.dueDate?.toISOString() ?? null,
                childCount: e.childCount,
                doneCount: e.doneCount,
              })),
            });
          });
        }),
    },
  },
});
