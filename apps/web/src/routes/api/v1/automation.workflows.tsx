import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { createWorkflow, listWorkflows, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth, ApiError } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveProject } from "@/lib/api-resolvers";

const AUTOMATION_NODE_TYPES = [
  "trigger_event",
  "trigger_schedule",
  "condition_property",
  "action_set_property",
  "action_add_label",
  "action_comment",
  "action_notify",
  "action_link_issue",
  "action_create_subtask",
  "action_webhook",
  "delay",
] as const;

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(AUTOMATION_NODE_TYPES),
  config: z.record(z.string(), z.any()),
  position: z.object({ x: z.number(), y: z.number() }),
});
const edgeSchema = z.object({ fromNodeId: z.string().min(1), fromHandle: z.enum(["true", "false"]).optional(), toNodeId: z.string().min(1) });

const createWorkflowSchema = z.object({
  projectKey: z.string().min(1),
  name: z.string().min(1),
  dryRun: z.boolean().optional(),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema),
});

export const Route = createFileRoute("/api/v1/automation/workflows")({
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
            const workflows = await listWorkflows(tx, project.id);
            return jsonResponse({ data: workflows });
          });
        }),

      POST: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = createWorkflowSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            const project = await resolveProject(tx, ctx.organizationId, body.projectKey);
            const { workflowId } = await createWorkflow(tx, {
              organizationId: ctx.organizationId,
              projectId: project.id,
              name: body.name,
              dryRun: body.dryRun,
              createdBy: ctx.userId,
              nodes: body.nodes,
              edges: body.edges,
            });
            return jsonResponse({ id: workflowId }, 201);
          });
        }),
    },
  },
});
