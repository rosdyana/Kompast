import type { Node, Edge } from "@xyflow/react";
import type { AutomationNodeType } from "./node-type-config";

export interface WorkflowNodeData {
  nodeType: AutomationNodeType;
  name?: string;
  config: Record<string, unknown>;
  [key: string]: unknown;
}

export type WorkflowNode = Node<WorkflowNodeData>;

export interface ApiNode {
  id: string;
  type: AutomationNodeType;
  name?: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface ApiEdge {
  fromNodeId: string;
  fromHandle?: string;
  toNodeId: string;
}

export function toRFNodes(nodes: ApiNode[]): WorkflowNode[] {
  return nodes.map((n) => ({
    id: n.id,
    type: "automationNode",
    position: n.position,
    data: { nodeType: n.type, name: n.name ?? undefined, config: (n.config as Record<string, unknown>) ?? {} },
  }));
}

export function toRFEdges(edges: ApiEdge[]): Edge[] {
  return edges.map((e, i) => ({
    id: `edge-${e.fromNodeId}-${e.fromHandle ?? "x"}-${e.toNodeId}-${i}`,
    source: e.fromNodeId,
    sourceHandle: e.fromHandle ?? null,
    target: e.toNodeId,
  }));
}

export function fromRFGraph(nodes: WorkflowNode[], edges: Edge[]): { nodes: ApiNode[]; edges: ApiEdge[] } {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.nodeType, name: n.data.name ?? undefined, config: n.data.config, position: n.position })),
    edges: edges.map((e) => ({ fromNodeId: e.source, fromHandle: e.sourceHandle ?? undefined, toNodeId: e.target })),
  };
}

export function newNodeId(): string {
  return `anode-${crypto.randomUUID()}`;
}
