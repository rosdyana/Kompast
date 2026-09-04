import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { updateIssue, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveIssue, resolveUserByEmail } from "@/lib/api-resolvers";

const updateIssueSchema = z.object({
  title: z.string().min(1).optional(),
  priority: z.enum(["lowest", "low", "medium", "high", "highest"]).optional(),
  assigneeEmail: z.email().nullable().optional(),
  storyPoints: z.number().nullable().optional(),
  dueDate: z.iso.datetime().nullable().optional(),
  startDate: z.iso.datetime().nullable().optional(),
  epicKey: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const Route = createFileRoute("/api/v1/issues/$issueKey")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const { project, issue } = await resolveIssue(tx, ctx.organizationId, params.issueKey);
            return jsonResponse({
              key: `${project.key}-${issue.keySeq}`,
              id: issue.id,
              title: issue.title,
              typeId: issue.typeId,
              statusId: issue.statusId,
              priority: issue.priority,
              assigneeId: issue.assigneeId,
              reporterId: issue.reporterId,
              storyPoints: issue.storyPoints,
              dueDate: issue.dueDate,
              startDate: issue.startDate,
              epicId: issue.epicId,
              labels: issue.labels,
              createdAt: issue.createdAt,
              updatedAt: issue.updatedAt,
            });
          });
        }),

      PATCH: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = updateIssueSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            const { issue } = await resolveIssue(tx, ctx.organizationId, params.issueKey);

            const assigneeId =
              body.assigneeEmail === undefined
                ? undefined
                : body.assigneeEmail === null
                  ? null
                  : await resolveUserByEmail(tx, ctx.organizationId, body.assigneeEmail);

            const epicId =
              body.epicKey === undefined
                ? undefined
                : body.epicKey === null
                  ? null
                  : (await resolveIssue(tx, ctx.organizationId, body.epicKey)).issue.id;

            await updateIssue(tx, issue.id, {
              title: body.title,
              priority: body.priority,
              assigneeId,
              storyPoints: body.storyPoints,
              dueDate: body.dueDate === undefined ? undefined : body.dueDate === null ? null : new Date(body.dueDate),
              startDate: body.startDate === undefined ? undefined : body.startDate === null ? null : new Date(body.startDate),
              epicId,
              labels: body.labels,
              descriptionJson: body.description !== undefined ? { text: body.description } : undefined,
              actorId: ctx.userId,
              origin: ctx.origin,
              originClient: request.headers.get("user-agent") ?? undefined,
            });

            return jsonResponse({ ok: true });
          });
        }),
    },
  },
});
