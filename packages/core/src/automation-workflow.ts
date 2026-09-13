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
  /** Optional human-readable key for {{steps.<name>...}} expression references — must be unique within the graph (see validateGraph). */
  name?: string | null;
  config: Json;
  position: { x: number; y: number };
}

export interface AutomationEdgeInput {
  fromNodeId: string;
  /** Free text: "true"/"false" for condition_property, a case label (or "default") for condition_switch, otherwise omitted. */
  fromHandle?: string;
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
      nodes.map((n) => ({ id: n.id, workflowId, type: n.type, name: n.name ?? null, config: n.config, position: n.position })),
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

export async function getWorkflowRun(tx: Tx, runId: string) {
  const [run] = await tx.select().from(schema.automationWorkflowRun).where(eq(schema.automationWorkflowRun.id, runId));
  if (!run) return null;
  const steps = await tx
    .select({ step: schema.automationWorkflowRunStep, nodeType: schema.automationNode.type, nodeName: schema.automationNode.name })
    .from(schema.automationWorkflowRunStep)
    .innerJoin(schema.automationNode, eq(schema.automationNode.id, schema.automationWorkflowRunStep.nodeId))
    .where(eq(schema.automationWorkflowRunStep.runId, runId))
    .orderBy(schema.automationWorkflowRunStep.createdAt);
  return { ...run, steps: steps.map((s) => ({ ...s.step, nodeType: s.nodeType, nodeName: s.nodeName })) };
}

/**
 * Node types that require a real issueId to execute (they read/write issue
 * state via `run.context.issueId` or a loop's current item — see
 * automation-execution.ts's requireIssueId). A schedule tick has no
 * triggering issue of its own (claimDueWorkflowSchedules creates its run
 * with `context: {}`), so one of these reached WITHOUT first passing
 * through a loop_each over issue ids (e.g. fed by find_issues) would fail
 * at runtime. condition_switch is deliberately included even though it
 * "only" reads a property, for the same reason condition_property is.
 */
const NODE_TYPES_REQUIRING_ISSUE_ID = new Set<AutomationNodeType>([
  "condition_property",
  "condition_switch",
  "action_set_property",
  "action_add_label",
  "action_comment",
  "action_notify",
  "action_link_issue",
  "action_create_subtask",
]);

/**
 * Same forward BFS shape as the reachability check above, but does not expand PAST a
 * loop_each node — a loop_each over issue ids is exactly where an issueId
 * first becomes available on a schedule-triggered path (see
 * automation-execution.ts's resolveIssueId), so anything reached without
 * crossing one still has no issueId source. Used only for the
 * trigger_schedule validation below.
 */
function nodesReachableWithoutIssueContext(startId: string, nodes: AutomationNodeInput[], edges: AutomationEdgeInput[]): AutomationNodeInput[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>([startId]);
  const queue = [startId];
  const result: AutomationNodeInput[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentNode = byId.get(current);
    if (currentNode && currentNode.type === "loop_each" && current !== startId) continue;
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

  const seenNames = new Set<string>();
  for (const node of nodes) {
    if (!node.name) continue;
    if (seenNames.has(node.name)) throw new AutomationGraphError(`Node name "${node.name}" is used by more than one node — names must be unique within a workflow`);
    seenNames.add(node.name);
  }

  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const fromNode = nodesById.get(edge.fromNodeId)!;
    if (fromNode.type === "condition_property") {
      if (edge.fromHandle !== "true" && edge.fromHandle !== "false") {
        throw new AutomationGraphError(`condition_property node "${edge.fromNodeId}"'s outgoing edge must have fromHandle "true" or "false", got "${edge.fromHandle}"`);
      }
    } else if (fromNode.type === "condition_switch") {
      const cases = (fromNode.config as { cases?: string[] }).cases ?? [];
      if (!edge.fromHandle || (!cases.includes(edge.fromHandle) && edge.fromHandle !== "default")) {
        throw new AutomationGraphError(`condition_switch node "${edge.fromNodeId}"'s outgoing edge fromHandle "${edge.fromHandle}" must be one of its configured cases, or "default"`);
      }
    } else if (edge.fromHandle) {
      throw new AutomationGraphError(`"${fromNode.type}" node "${edge.fromNodeId}" is not a branching node and its outgoing edges must not set fromHandle`);
    }
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
    if (node.type === "loop_each") {
      for (const edge of edges) {
        if (edge.fromNodeId === node.id && edge.fromHandle) {
          throw new AutomationGraphError(`loop_each node "${node.id}" is not a branching node and its outgoing edges must not set fromHandle`);
        }
      }
    }

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

    for (const downstream of nodesReachableWithoutIssueContext(node.id, nodes, edges)) {
      if (NODE_TYPES_REQUIRING_ISSUE_ID.has(downstream.type)) {
        throw new AutomationGraphError(
          `"${downstream.type}" requires an issueId; place it downstream of a loop_each over issue ids (e.g. via find_issues) when triggered by a schedule`,
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
