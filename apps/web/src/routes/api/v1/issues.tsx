import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { asc, eq, gt, and, schema } from "@kompast/db";
import { createIssue, withAuthorizedTenant, withIdempotency } from "@kompast/core";
import { requireApiAuth } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveProject, resolveIssueType, resolveStatus, resolveUserByEmail } from "@/lib/api-resolvers";
import { ApiError } from "@/lib/api-auth";

function serializeIssue(issue: typeof schema.issue.$inferSelect, projectKey: string) {
  return {
    key: `${projectKey}-${issue.keySeq}`,
    id: issue.id,
    title: issue.title,
    typeId: issue.typeId,
    statusId: issue.statusId,
    priority: issue.priority,
    assigneeId: issue.assigneeId,
    reporterId: issue.reporterId,
    storyPoints: issue.storyPoints,
    dueDate: issue.dueDate,
    labels: issue.labels,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

const createIssueSchema = z.object({
  projectKey: z.string().min(1),
  title: z.string().min(1),
  type: z.string().optional(),
  status: z.string().optional(),
  priority: z.enum(["lowest", "low", "medium", "high", "highest"]).optional(),
  assigneeEmail: z.email().optional(),
  description: z.string().optional(),
  labels: z.array(z.string()).optional(),
  storyPoints: z.number().optional(),
  dueDate: z.iso.datetime().optional(),
});

export const Route = createFileRoute("/api/v1/issues")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          const url = new URL(request.url);
          const projectKey = url.searchParams.get("projectKey");
          if (!projectKey) throw new ApiError(400, "Bad Request", "projectKey query param is required");
          const limit = Math.min(Number(url.searchParams.get("limit")) || 25, 100);
          const cursor = Number(url.searchParams.get("cursor")) || 0;

          return withAuthorizedTenant(ctx, async (tx) => {
            const project = await resolveProject(tx, ctx.organizationId, projectKey);
            const rows = await tx
              .select()
              .from(schema.issue)
              .where(and(eq(schema.issue.projectId, project.id), gt(schema.issue.keySeq, cursor)))
              .orderBy(asc(schema.issue.keySeq))
              .limit(limit);

            const nextCursor = rows.length === limit ? rows[rows.length - 1]!.keySeq : null;
            return jsonResponse({ data: rows.map((r) => serializeIssue(r, project.key)), nextCursor });
          });
        }),

      POST: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = createIssueSchema.parse(await request.json());
          const idempotencyKey = request.headers.get("idempotency-key");

          return withAuthorizedTenant(ctx, async (tx) => {
            const project = await resolveProject(tx, ctx.organizationId, body.projectKey);
            const run = async () => {
              const [type, status, assigneeId] = await Promise.all([
                resolveIssueType(tx, project.id, body.type),
                resolveStatus(tx, project.id, body.status),
                body.assigneeEmail ? resolveUserByEmail(tx, ctx.organizationId, body.assigneeEmail) : Promise.resolve(undefined),
              ]);

              const created = await createIssue(tx, {
                organizationId: ctx.organizationId,
                projectId: project.id,
                typeId: type.id,
                statusId: status.id,
                title: body.title,
                reporterId: ctx.userId,
                assigneeId,
                priority: body.priority,
                descriptionJson: body.description ? { text: body.description } : undefined,
                labels: body.labels,
                storyPoints: body.storyPoints,
                dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
                origin: ctx.origin,
                originClient: request.headers.get("user-agent") ?? undefined,
              });

              return { key: `${project.key}-${created.keySeq}`, id: created.issueId };
            };

            if (!idempotencyKey) return jsonResponse(await run(), 201);

            const { replayed, response } = await withIdempotency(tx, ctx.organizationId, "create_issue", idempotencyKey, run);
            return jsonResponse(response, replayed ? 200 : 201);
          });
        }),
    },
  },
});
