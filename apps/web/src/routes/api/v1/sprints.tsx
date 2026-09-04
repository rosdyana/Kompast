import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { createSprint, listSprints, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth, ApiError } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveProject, resolveBoardForProject } from "@/lib/api-resolvers";

function serializeSprint(sprint: { id: string; name: string; goal: string | null; state: string; cycle: string; startAt: Date | null; endAt: Date | null; capacityPoints: number | null }) {
  return {
    id: sprint.id,
    name: sprint.name,
    goal: sprint.goal,
    state: sprint.state,
    cycle: sprint.cycle,
    startAt: sprint.startAt?.toISOString() ?? null,
    endAt: sprint.endAt?.toISOString() ?? null,
    capacityPoints: sprint.capacityPoints,
  };
}

const createSprintSchema = z.object({
  projectKey: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().optional(),
  cycle: z.enum(["1w", "2w", "3w", "4w", "custom"]).optional(),
  startAt: z.iso.datetime().optional(),
  endAt: z.iso.datetime().optional(),
  capacityPoints: z.number().optional(),
});

export const Route = createFileRoute("/api/v1/sprints")({
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
            const sprints = await listSprints(tx, board.id);
            return jsonResponse({ data: sprints.map(serializeSprint) });
          });
        }),

      POST: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "sprints:write", "api");
          const body = createSprintSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            const project = await resolveProject(tx, ctx.organizationId, body.projectKey);
            const board = await resolveBoardForProject(tx, project.id);
            const { sprintId } = await createSprint(tx, {
              organizationId: ctx.organizationId,
              boardId: board.id,
              name: body.name,
              goal: body.goal,
              cycle: body.cycle,
              startAt: body.startAt ? new Date(body.startAt) : undefined,
              endAt: body.endAt ? new Date(body.endAt) : undefined,
              capacityPoints: body.capacityPoints,
            });
            return jsonResponse({ id: sprintId }, 201);
          });
        }),
    },
  },
});
