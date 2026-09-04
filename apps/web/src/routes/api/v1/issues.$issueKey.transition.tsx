import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { moveIssue, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveIssue, resolveStatus } from "@/lib/api-resolvers";

const transitionSchema = z.object({ status: z.string().min(1) });

export const Route = createFileRoute("/api/v1/issues/$issueKey/transition")({
  server: {
    handlers: {
      POST: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = transitionSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            const { project, issue } = await resolveIssue(tx, ctx.organizationId, params.issueKey);
            const status = await resolveStatus(tx, project.id, body.status);

            await moveIssue(tx, {
              issueId: issue.id,
              toStatusId: status.id,
              actorId: ctx.userId,
              origin: ctx.origin,
              originClient: request.headers.get("user-agent") ?? undefined,
            });

            return jsonResponse({ ok: true, status: status.name });
          });
        }),
    },
  },
});
