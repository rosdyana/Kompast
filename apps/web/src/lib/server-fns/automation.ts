import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { createAutomationRule, listAutomationRules, listAutomationRuns, deleteAutomationRule, withAuthorizedTenant } from "@kompast/core";
import { schema, eq } from "@kompast/db";
import { requireAuthContext } from "../session";

export const listAutomationRulesFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listAutomationRules(tx, projectId));
  });

export const listAutomationRunsFn = createServerFn({ method: "GET" })
  .validator((ruleId: string) => ruleId)
  .handler(async ({ data: ruleId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listAutomationRuns(tx, ruleId));
  });

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
  projectId: z.string(),
  name: z.string().min(1),
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).optional(),
  actions: z.array(actionSchema).min(1),
  dryRun: z.boolean().optional(),
});

export const createAutomationRuleFn = createServerFn({ method: "POST" })
  .validator(createRuleSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      createAutomationRule(tx, {
        organizationId: ctx.organizationId,
        projectId: data.projectId,
        name: data.name,
        trigger: data.trigger,
        conditions: data.conditions,
        actions: data.actions,
        dryRun: data.dryRun,
        createdBy: ctx.userId,
      }),
    );
  });

export const setAutomationRuleEnabledFn = createServerFn({ method: "POST" })
  .validator((data: { ruleId: string; enabled: boolean }) => data)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => tx.update(schema.automationRule).set({ enabled: data.enabled, updatedAt: new Date() }).where(eq(schema.automationRule.id, data.ruleId)));
    return { ok: true } as const;
  });

export const deleteAutomationRuleFn = createServerFn({ method: "POST" })
  .validator((ruleId: string) => ruleId)
  .handler(async ({ data: ruleId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => deleteAutomationRule(tx, ruleId));
    return { ok: true } as const;
  });
