import { and, eq, schema, type Json } from "@kompast/db";
import type { Tx } from "./types";
import { id } from "./ids";

export type AutomationNodeType = (typeof schema.automationWorkflowNodeType)[number];

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
