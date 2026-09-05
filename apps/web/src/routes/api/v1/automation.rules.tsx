import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { createAutomationRule, listAutomationRules, withAuthorizedTenant } from "@kompast/core";
import { requireApiAuth, ApiError } from "@/lib/api-auth";
import { jsonResponse, handleApiRoute } from "@/lib/api-response";
import { resolveProject } from "@/lib/api-resolvers";

/**
 * Trigger/conditions/actions are accepted as-is (raw ids: statusId,
 * assigneeId, sprintId, ...) rather than human-friendly names — unlike
 * issues/pages REST, the caller here is expected to be the project
 * page's own rule-builder UI, which already has every relevant id from
 * the board data it loaded (getProjectBoardFn's issueTypes/statuses/
 * users), so there's no separate name-resolution step to build.
 */
const triggerSchema = z.object({ type: z.enum(["issue.created", "issue.updated", "issue.transitioned", "issue.assigned", "issue.commented"]) });
const conditionSchema = z.object({ field: z.string(), operator: z.enum(["eq", "neq", "in", "contains"]), value: z.any() });
const actionSchema = z.union([
  z.object({ type: z.literal("transition"), toStatusId: z.string() }),
  z.object({ type: z.literal("assign"), assigneeId: z.string().nullable() }),
  z.object({ type: z.literal("set_field"), field: z.enum(["priority", "storyPoints", "dueDate"]), value: z.any() }),
  z.object({ type: z.literal("add_label"), label: z.string() }),
  z.object({ type: z.literal("comment"), text: z.string() }),
  z.object({ type: z.literal("notify"), userId: z.string(), title: z.string(), body: z.string().optional() }),
  z.object({ type: z.literal("add_to_sprint"), sprintId: z.string() }),
  z.object({ type: z.literal("link_issue"), issueId: z.string() }),
  z.object({ type: z.literal("create_subtask"), typeId: z.string(), title: z.string().min(1) }),
]);

const createRuleSchema = z.object({
  projectKey: z.string().min(1),
  name: z.string().min(1),
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).optional(),
  actions: z.array(actionSchema).min(1),
  dryRun: z.boolean().optional(),
});

export const Route = createFileRoute("/api/v1/automation/rules")({
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
            const rules = await listAutomationRules(tx, project.id);
            return jsonResponse({ data: rules });
          });
        }),

      POST: async ({ request }) =>
        handleApiRoute(async () => {
          const ctx = await requireApiAuth(request, "issues:write", "api");
          const body = createRuleSchema.parse(await request.json());

          return withAuthorizedTenant(ctx, async (tx) => {
            const project = await resolveProject(tx, ctx.organizationId, body.projectKey);
            const { ruleId } = await createAutomationRule(tx, {
              organizationId: ctx.organizationId,
              projectId: project.id,
              name: body.name,
              trigger: body.trigger,
              conditions: body.conditions,
              actions: body.actions,
              dryRun: body.dryRun,
              createdBy: ctx.userId,
            });
            return jsonResponse({ id: ruleId }, 201);
          });
        }),
    },
  },
});
