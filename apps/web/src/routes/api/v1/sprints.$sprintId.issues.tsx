import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { addIssueToSprint, removeIssueFromSprint, listSprintIssues, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth, ApiError } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveSprint, resolveIssue } from "@/lib/api-resolvers";

const addIssueSchema = z.object({ issueKey: z.string().min(1) });

export const Route = createFileRoute("/api/v1/sprints/$sprintId/issues")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const sprint = await resolveSprint(tx, ctx.organizationId, params.sprintId);
            const issues = await listSprintIssues(tx, sprint.id);
            return jsonResponse({ data: issues.map((i) => ({ id: i.id, title: i.title, statusId: i.statusId, storyPoints: i.storyPoints })) });
          });
        }),

      POST: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "sprints:write", "api");
          const body = addIssueSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            const sprint = await resolveSprint(tx, ctx.organizationId, params.sprintId);
            const { issue } = await resolveIssue(tx, ctx.organizationId, body.issueKey);
            await addIssueToSprint(tx, sprint.id, issue.id);
            return jsonResponse({ ok: true }, 201);
          });
        }),

      DELETE: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "sprints:write", "api");
          const url = new URL(request.url);
          const issueKey = url.searchParams.get("issueKey");
          if (!issueKey) throw new ApiError(400, "Bad Request", "issueKey query param is required");

          return withAuthorizedTenant(ctx, async (tx) => {
            await resolveSprint(tx, ctx.organizationId, params.sprintId);
            const { issue } = await resolveIssue(tx, ctx.organizationId, issueKey);
            await removeIssueFromSprint(tx, issue.id);
            return jsonResponse({ ok: true });
          });
        }),
    },
  },
});
