import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { deleteWorkflow, getWorkflow, updateWorkflow, withAuthorizedTenant } from "@kompast/core";
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

const updateWorkflowSchema = z.object({
  projectKey: z.string().min(1),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  nodes: z.array(nodeSchema).optional(),
  edges: z.array(edgeSchema).optional(),
});

export const Route = createFileRoute("/api/v1/automation/workflows/$workflowId")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:read", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const workflow = await getWorkflow(tx, params.workflowId);
            if (!workflow) throw new ApiError(404, "Not Found", `Workflow ${params.workflowId} not found`);
            return jsonResponse({ data: workflow });
          });
        }),

      PATCH: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = updateWorkflowSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            const project = await resolveProject(tx, ctx.organizationId, body.projectKey);
            const existing = await getWorkflow(tx, params.workflowId);
            if (!existing || existing.projectId !== project.id) throw new ApiError(404, "Not Found", `Workflow ${params.workflowId} not found`);
            if (body.nodes !== undefined || body.edges !== undefined) {
              if (body.nodes === undefined || body.edges === undefined) throw new ApiError(400, "Bad Request", "nodes and edges must be sent together");
            }
            await updateWorkflow(tx, {
              workflowId: params.workflowId,
              projectId: project.id,
              name: body.name,
              enabled: body.enabled,
              dryRun: body.dryRun,
              nodes: body.nodes,
              edges: body.edges,
            });
            return jsonResponse({ ok: true });
          });
        }),

      DELETE: async ({ request, params }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          return withAuthorizedTenant(ctx, async (tx) => {
            const existing = await getWorkflow(tx, params.workflowId);
            if (!existing) throw new ApiError(404, "Not Found", `Workflow ${params.workflowId} not found`);
            await deleteWorkflow(tx, params.workflowId);
            return jsonResponse({ ok: true });
          });
        }),
    },
  },
});
