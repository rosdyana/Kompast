import { and, desc, eq, schema, type Json } from "@kompast/db";
import { CronExpressionParser } from "cron-parser";
import type { Tx } from "./types";
import { id } from "./ids";

export type AutomationNodeType = (typeof schema.automationWorkflowNodeType)[number];

/**
 * Thrown by validateGraph for any save-time graph-shape problem (a dangling
 * edge, a node unreachable from any trigger, an unsupported node type
 * downstream of a schedule trigger, a malformed cron string). A distinct
 * class rather than a plain Error so apps/web's handleApiRoute can map it
 * to a 400 with the real validation message, instead of falling through to
 * a generic 500 — see apps/web/src/lib/api-response.ts.
 */
export class AutomationGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationGraphError";
  }
}

export interface AutomationNodeInput {
  id: string;
  type: AutomationNodeType;
  config: Json;
  position: { x: number; y: number };
}

export interface AutomationEdgeInput {
  fromNodeId: string;
  fromHandle?: "true" | "false";
  toNodeId: string;
}

export interface CreateWorkflowInput {
  organizationId: string;
  projectId: string;
  name: string;
  dryRun?: boolean;
  createdBy: string;
  nodes: AutomationNodeInput[];
  edges: AutomationEdgeInput[];
}

async function insertGraph(tx: Tx, workflowId: string, nodes: AutomationNodeInput[], edges: AutomationEdgeInput[]) {
  if (nodes.length > 0) {
    await tx.insert(schema.automationNode).values(
      nodes.map((n) => ({ id: n.id, workflowId, type: n.type, config: n.config, position: n.position })),
    );
  }
  if (edges.length > 0) {
    await tx.insert(schema.automationEdge).values(
      edges.map((e) => ({ id: id("aedge"), workflowId, fromNodeId: e.fromNodeId, fromHandle: e.fromHandle ?? null, toNodeId: e.toNodeId })),
    );
  }
}

export async function createWorkflow(tx: Tx, input: CreateWorkflowInput): Promise<{ workflowId: string }> {
  validateGraph(input.nodes, input.edges);
  const workflowId = id("wf");
  await tx.insert(schema.automationWorkflow).values({
    id: workflowId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    name: input.name,
    dryRun: input.dryRun ?? false,
    createdBy: input.createdBy,
  });
  await insertGraph(tx, workflowId, input.nodes, input.edges);
  return { workflowId };
}

export async function listWorkflows(tx: Tx, projectId: string) {
  return tx.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.projectId, projectId));
}

export async function getWorkflow(tx: Tx, workflowId: string) {
  const [workflow] = await tx.select().from(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));
  if (!workflow) return null;
  const [nodes, edges] = await Promise.all([
    tx.select().from(schema.automationNode).where(eq(schema.automationNode.workflowId, workflowId)),
    tx.select().from(schema.automationEdge).where(eq(schema.automationEdge.workflowId, workflowId)),
  ]);
  return { ...workflow, nodes, edges };
}

export async function listWorkflowRuns(tx: Tx, workflowId: string, limit = 50) {
  return tx
    .select()
    .from(schema.automationWorkflowRun)
    .where(eq(schema.automationWorkflowRun.workflowId, workflowId))
    .orderBy(desc(schema.automationWorkflowRun.createdAt))
    .limit(limit);
}

/**
 * Node types safe to have downstream of a trigger_schedule node. A schedule
 * tick has no triggering issue (claimDueWorkflowSchedules creates its run
 * with `context: {}` — see that function's own comment), so any node that
 * reads/writes issue state (condition_property, action_set_property,
 * action_add_label, action_comment, action_notify, action_link_issue,
 * action_create_subtask) would fail at runtime reaching for the
 * non-existent `run.context.issueId`. Rejected here at save time instead —
 * a deliberate, documented v1 scope boundary (schedule-triggered workflows
 * are for issue-independent actions only, e.g. digests/webhooks), not a
 * workaround. See the design spec's "Node types" / schedule trigger notes.
 */
const SCHEDULE_SAFE_DOWNSTREAM_NODE_TYPES = new Set<AutomationNodeType>(["trigger_schedule", "action_webhook", "delay"]);

/** Every node reachable by following edges forward from `startId`, not including `startId` itself. */
function nodesReachableFrom(startId: string, nodes: AutomationNodeInput[], edges: AutomationEdgeInput[]): AutomationNodeInput[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([startId]);
  const queue = [startId];
  const result: AutomationNodeInput[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.fromNodeId !== current || visited.has(edge.toNodeId)) continue;
      visited.add(edge.toNodeId);
      const node = byId.get(edge.toNodeId);
      if (node) result.push(node);
      queue.push(edge.toNodeId);
    }
  }
  return result;
}

function validateGraph(nodes: AutomationNodeInput[], edges: AutomationEdgeInput[]): void {
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (!nodeIds.has(edge.fromNodeId)) throw new AutomationGraphError(`Edge references fromNodeId "${edge.fromNodeId}", which does not exist in this graph`);
    if (!nodeIds.has(edge.toNodeId)) throw new AutomationGraphError(`Edge references toNodeId "${edge.toNodeId}", which does not exist in this graph`);
  }

  const reachable = new Set<string>();
  const queue = nodes.filter((n) => n.type === "trigger_event" || n.type === "trigger_schedule").map((n) => n.id);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of edges) if (edge.fromNodeId === current) queue.push(edge.toNodeId);
  }

  for (const node of nodes) {
    if (!reachable.has(node.id)) throw new AutomationGraphError(`Node "${node.id}" (${node.type}) is not reachable from any trigger`);
  }

  for (const node of nodes) {
    if (node.type !== "trigger_schedule") continue;

    // Belt-and-braces: also caught (and re-caught more coarsely) by
    // apps/worker's own per-node try/catch around claimDueWorkflowSchedules
    // — see that function's comment. This is the primary defense: a bad
    // cron string should never be persisted in the first place.
    const config = node.config as { cron?: string };
    try {
      CronExpressionParser.parse(config.cron ?? "");
    } catch {
      throw new AutomationGraphError(`Invalid cron expression on schedule trigger: "${config.cron}"`);
    }

    for (const downstream of nodesReachableFrom(node.id, nodes, edges)) {
      if (!SCHEDULE_SAFE_DOWNSTREAM_NODE_TYPES.has(downstream.type)) {
        throw new AutomationGraphError(
          `Schedule-triggered workflows can only contain action_webhook and delay nodes downstream of the trigger; "${downstream.type}" requires an issue and is not supported here yet`,
        );
      }
    }
  }
}

export interface UpdateWorkflowInput {
  workflowId: string;
  projectId: string;
  name?: string;
  enabled?: boolean;
  dryRun?: boolean;
  nodes?: AutomationNodeInput[];
  edges?: AutomationEdgeInput[];
}

/** `nodes`/`edges`, if given, always come as a PAIR — the caller sends the whole current canvas state, never a partial graph. */
export async function updateWorkflow(tx: Tx, input: UpdateWorkflowInput): Promise<void> {
  const set: Partial<{ name: string; enabled: boolean; dryRun: boolean; updatedAt: Date }> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.dryRun !== undefined) set.dryRun = input.dryRun;

  const result = await tx
    .update(schema.automationWorkflow)
    .set(set)
    .where(and(eq(schema.automationWorkflow.id, input.workflowId), eq(schema.automationWorkflow.projectId, input.projectId)))
    .returning({ id: schema.automationWorkflow.id });
  if (result.length === 0) throw new Error(`Workflow ${input.workflowId} not found in project ${input.projectId}`);

  if (input.nodes && input.edges) {
    validateGraph(input.nodes, input.edges);
    // Edges reference nodes by id — delete edges first, then nodes (both cascade from the node FK anyway, but explicit order avoids relying on cascade timing).
    await tx.delete(schema.automationEdge).where(eq(schema.automationEdge.workflowId, input.workflowId));
    await tx.delete(schema.automationNode).where(eq(schema.automationNode.workflowId, input.workflowId));
    await insertGraph(tx, input.workflowId, input.nodes, input.edges);
  }
}

export async function setWorkflowEnabled(tx: Tx, workflowId: string, enabled: boolean): Promise<void> {
  await tx.update(schema.automationWorkflow).set({ enabled, updatedAt: new Date() }).where(eq(schema.automationWorkflow.id, workflowId));
}

export async function deleteWorkflow(tx: Tx, workflowId: string): Promise<void> {
  await tx.delete(schema.automationWorkflow).where(eq(schema.automationWorkflow.id, workflowId));
}
