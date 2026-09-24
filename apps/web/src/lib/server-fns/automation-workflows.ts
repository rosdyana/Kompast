import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import { createWorkflow, listWorkflows, getWorkflow, updateWorkflow, deleteWorkflow, listWorkflowRuns, getWorkflowRun, withAuthorizedTenant } from "@kompast/core";
import { and, desc, inArray, like, schema, type Json } from "@kompast/db";
import { requireAuthContext } from "../session";

// Duplicated locally rather than imported from @kompast/core at module scope
// (same convention as the old automation server-fns file) — keeps the
// Postgres client and its transitive deps out of the browser bundle.
const AUTOMATION_NODE_TYPES = [
  "trigger_event",
  "trigger_schedule",
  "condition_property",
  "condition_switch",
  "action_set_property",
  "action_add_label",
  "action_comment",
  "action_notify",
  "action_link_issue",
  "action_create_subtask",
  "action_webhook",
  "find_issues",
  "loop_each",
  "delay",
] as const;

const nodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(AUTOMATION_NODE_TYPES),
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.any()),
  position: z.object({ x: z.number(), y: z.number() }),
});
const edgeSchema = z.object({ fromNodeId: z.string().min(1), fromHandle: z.string().min(1).optional(), toNodeId: z.string().min(1) });

export const listWorkflowsFn = createServerFn({ method: "GET" })
  .validator((projectId: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, async (tx) => {
      const workflows = await listWorkflows(tx, projectId);
      const ids = workflows.map((w) => w.id);
      if (ids.length === 0) return [];
      // List-row context only (read side): each workflow's trigger node and
      // its most recent run, so the list can show "When issue.created · last
      // run 2h ago · failed" without opening every canvas.
      const [triggers, runs] = await Promise.all([
        tx
          .select({ workflowId: schema.automationNode.workflowId, type: schema.automationNode.type, config: schema.automationNode.config })
          .from(schema.automationNode)
          .where(and(inArray(schema.automationNode.workflowId, ids), like(schema.automationNode.type, "trigger_%"))),
        tx
          .select({ workflowId: schema.automationWorkflowRun.workflowId, status: schema.automationWorkflowRun.status, createdAt: schema.automationWorkflowRun.createdAt })
          .from(schema.automationWorkflowRun)
          .where(inArray(schema.automationWorkflowRun.workflowId, ids))
          .orderBy(desc(schema.automationWorkflowRun.createdAt))
          .limit(500),
      ]);
      return workflows
        .map((w) => {
          const trigger = triggers.find((tr) => tr.workflowId === w.id) ?? null;
          const lastRun = runs.find((r) => r.workflowId === w.id) ?? null;
          return { ...w, trigger: trigger ? { type: trigger.type, config: trigger.config as { [key: string]: Json } } : null, lastRun };
        })
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    });
  });

export const getWorkflowFn = createServerFn({ method: "GET" })
  .validator((workflowId: string) => workflowId)
  .handler(async ({ data: workflowId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => getWorkflow(tx, workflowId));
  });

const createWorkflowSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  nodes: z.array(nodeSchema).min(1),
  edges: z.array(edgeSchema),
});

export const createWorkflowFn = createServerFn({ method: "POST" })
  .validator(createWorkflowSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) =>
      createWorkflow(tx, { organizationId: ctx.organizationId, projectId: data.projectId, name: data.name, nodes: data.nodes, edges: data.edges, createdBy: ctx.userId }),
    );
  });

const updateWorkflowSchema = z.object({
  workflowId: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  nodes: z.array(nodeSchema).optional(),
  edges: z.array(edgeSchema).optional(),
});

export const updateWorkflowFn = createServerFn({ method: "POST" })
  .validator(updateWorkflowSchema)
  .handler(async ({ data }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => updateWorkflow(tx, data));
    return { ok: true } as const;
  });

export const deleteWorkflowFn = createServerFn({ method: "POST" })
  .validator((workflowId: string) => workflowId)
  .handler(async ({ data: workflowId }) => {
    const ctx = await requireAuthContext();
    await withAuthorizedTenant(ctx, (tx) => deleteWorkflow(tx, workflowId));
    return { ok: true } as const;
  });

export const listWorkflowRunsFn = createServerFn({ method: "GET" })
  .validator((workflowId: string) => workflowId)
  .handler(async ({ data: workflowId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => listWorkflowRuns(tx, workflowId));
  });

export const getWorkflowRunFn = createServerFn({ method: "GET" })
  .validator((runId: string) => runId)
  .handler(async ({ data: runId }) => {
    const ctx = await requireAuthContext();
    return withAuthorizedTenant(ctx, (tx) => getWorkflowRun(tx, runId));
  });
