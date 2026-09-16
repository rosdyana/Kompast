import { useCallback, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  addEdge,
  Background,
  Controls,
  type Connection,
  type NodeTypes,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { AutomationNodeCard } from "./AutomationNodeCard";
import { NodePalette } from "./NodePalette";
import { NodeConfigPanel } from "./NodeConfigPanel";
import { RunHistoryPanel } from "./RunHistoryPanel";
import { getNodeTypeConfigs, type AutomationNodeType } from "./node-type-config";
import { toRFNodes, toRFEdges, fromRFGraph, newNodeId, type ApiNode, type ApiEdge, type WorkflowNode } from "./graph-serialize";
import { updateWorkflowFn, deleteWorkflowFn } from "@/lib/server-fns/automation-workflows";

const NODE_TYPES: NodeTypes = { automationNode: AutomationNodeCard };

export function WorkflowCanvas({
  workflowId,
  projectId,
  teamId,
  projectKey,
  initialName,
  initialEnabled,
  initialDryRun,
  initialNodes,
  initialEdges,
}: {
  workflowId: string;
  projectId: string;
  teamId: string;
  projectKey: string;
  initialName: string;
  initialEnabled: boolean;
  initialDryRun: boolean;
  initialNodes: ApiNode[];
  initialEdges: ApiEdge[];
}) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvasInner
        workflowId={workflowId}
        projectId={projectId}
        teamId={teamId}
        projectKey={projectKey}
        initialName={initialName}
        initialEnabled={initialEnabled}
        initialDryRun={initialDryRun}
        initialNodes={initialNodes}
        initialEdges={initialEdges}
      />
    </ReactFlowProvider>
  );
}

function WorkflowCanvasInner({
  workflowId,
  projectId,
  teamId,
  projectKey,
  initialName,
  initialEnabled,
  initialDryRun,
  initialNodes,
  initialEdges,
}: {
  workflowId: string;
  projectId: string;
  teamId: string;
  projectKey: string;
  initialName: string;
  initialEnabled: boolean;
  initialDryRun: boolean;
  initialNodes: ApiNode[];
  initialEdges: ApiEdge[];
}) {
  const navigate = useNavigate();
  const { t } = useTranslation("workflow");
  const [nodes, setNodes, onNodesChange] = useNodesState(useMemo(() => toRFNodes(initialNodes), [initialNodes]));
  const [edges, setEdges, onEdgesChange] = useEdgesState(useMemo(() => toRFEdges(initialEdges), [initialEdges]));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [name, setName] = useState(initialName);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [dryRun, setDryRun] = useState(initialDryRun);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runsRefreshSignal, setRunsRefreshSignal] = useState(0);
  const { isArmed, arm } = useDeleteArm();

  const markDirty = useCallback(() => setDirty(true), []);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge(connection, eds));
      markDirty();
    },
    [setEdges, markDirty],
  );

  function handleAddNode(type: AutomationNodeType) {
    const meta = getNodeTypeConfigs(t)[type];
    const id = newNodeId();
    setNodes((nds) => [
      ...nds,
      { id, type: "automationNode", position: { x: 100 + nds.length * 30, y: 100 + nds.length * 30 }, data: { nodeType: type, config: { ...meta.defaultConfig } } },
    ]);
    markDirty();
  }

  function handleChangeConfig(nodeId: string, config: Record<string, unknown>) {
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, config } } : n)));
    markDirty();
  }

  function handleChangeName(nodeId: string, name: string) {
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, name: name || undefined } } : n)));
    markDirty();
  }

  function handleDeleteNode(nodeId: string) {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelectedNodeId(null);
    markDirty();
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const graph = fromRFGraph(nodes as WorkflowNode[], edges);
      await updateWorkflowFn({ data: { workflowId, projectId, name, dryRun, nodes: graph.nodes, edges: graph.edges } });
      setDirty(false);
      setRunsRefreshSignal((s) => s + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("canvas.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleEnabled(next: boolean) {
    setEnabled(next);
    try {
      await updateWorkflowFn({ data: { workflowId, projectId, enabled: next } });
    } catch (err) {
      setEnabled(!next);
      setSaveError(err instanceof Error ? err.message : t("canvas.toggleFailed"));
    }
  }

  async function handleDelete() {
    if (!isArmed) {
      arm();
      return;
    }
    await deleteWorkflowFn({ data: workflowId });
    navigate({ to: "/projects/$teamId/$projectKey", params: { teamId, projectKey }, search: { tab: "automation" } });
  }

  function handleBack() {
    if (dirty && !window.confirm(t("canvas.discardChangesConfirm"))) return;
    navigate({ to: "/projects/$teamId/$projectKey", params: { teamId, projectKey }, search: { tab: "automation" } });
  }

  const selectedNode = (nodes as WorkflowNode[]).find((n) => n.id === selectedNodeId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
        <button
          type="button"
          onClick={handleBack}
          aria-label={t("canvas.backLabel")}
          className="flex flex-none items-center gap-1 text-xs text-text-3 hover:text-text-2"
        >
          <ArrowLeft size={13} strokeWidth={1.75} />
        </button>
        <input value={name} onChange={(e) => { setName(e.target.value); markDirty(); }} className="rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[13px] font-semibold" />
        <label className="flex items-center gap-1.5 text-[11.5px] text-text-3">
          <input type="checkbox" checked={enabled} onChange={(e) => handleToggleEnabled(e.target.checked)} />
          {t("canvas.enabledLabel")}
        </label>
        <label className="flex items-center gap-1.5 text-[11.5px] text-text-3">
          <input type="checkbox" checked={dryRun} onChange={(e) => { setDryRun(e.target.checked); markDirty(); }} />
          {t("canvas.dryRunLabel")}
        </label>
        <div className="ml-auto flex items-center gap-2">
          {saveError && <span className="type-body text-danger">{saveError}</span>}
          <Button variant="primary" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? t("canvas.saving") : t("canvas.save")}
          </Button>
          <Button
            variant="outline"
            onClick={handleDelete}
            style={isArmed ? { color: "var(--danger)", borderColor: "var(--danger)" } : undefined}
          >
            {isArmed ? t("canvas.clickAgainToDelete") : t("canvas.deleteWorkflow")}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <NodePalette onAdd={handleAddNode} />
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              if (changes.some((c) => c.type !== "select" && c.type !== "dimensions")) markDirty();
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes);
              if (changes.some((c) => c.type !== "select")) markDirty();
            }}
            onConnect={onConnect}
            nodeTypes={NODE_TYPES}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        {selectedNode ? (
          <NodeConfigPanel node={selectedNode} onChangeConfig={handleChangeConfig} onChangeName={handleChangeName} onDelete={handleDeleteNode} />
        ) : (
          <RunHistoryPanel workflowId={workflowId} refreshSignal={runsRefreshSignal} />
        )}
      </div>
    </div>
  );
}

function useDeleteArm() {
  const [armed, setArmed] = useState(false);
  return { isArmed: armed, arm: () => setArmed(true) };
}
