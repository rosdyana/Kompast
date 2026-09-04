import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { completeSprint, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveSprint } from "@/lib/api-resolvers";

const completeSchema = z.object({ carryToSprintId: z.string().optional() });

export const Route = createFileRoute("/api/v1/sprints/$sprintId/complete")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "sprints:write", "api");
          const body = completeSchema.parse(await request.json().catch(() => ({})));

          return withAuthorizedTenant(ctx, async (tx) => {
            const sprint = await resolveSprint(tx, ctx.organizationId, params.sprintId);
            if (body.carryToSprintId) await resolveSprint(tx, ctx.organizationId, body.carryToSprintId);
            const result = await completeSprint(tx, { sprintId: sprint.id, actorId: ctx.userId, carryToSprintId: body.carryToSprintId });
            return jsonResponse(result);
          });
        }),
    },
  },
});
