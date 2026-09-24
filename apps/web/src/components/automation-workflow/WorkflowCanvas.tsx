import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  type Connection,
  type NodeTypes,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Check, Trash2 } from "lucide-react";
import { Button, IconButton } from "@kompast/ui/Button";
import { Badge } from "@kompast/ui/Badge";
import { Switch } from "@kompast/ui/Switch";
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
  const { isArmed, arm, disarm } = useDeleteArm();

  // Warn before a tab close/reload would drop unsaved graph edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

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
    disarm();
    await deleteWorkflowFn({ data: workflowId });
    navigate({ to: "/projects/$teamId/$projectKey", params: { teamId, projectKey }, search: { tab: "automation" } });
  }

  function handleBack() {
    if (dirty && !window.confirm(t("canvas.discardChangesConfirm"))) return;
    navigate({ to: "/projects/$teamId/$projectKey", params: { teamId, projectKey }, search: { tab: "automation" } });
  }

  const selectedNode = (nodes as WorkflowNode[]).find((n) => n.id === selectedNodeId) ?? null;

  return (
    <div className="kp-flow flex h-full flex-col">
      <div className="flex min-h-12 flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-3 py-2">
        <IconButton aria-label={t("canvas.backLabel")} title={t("canvas.backLabel")} onClick={handleBack}>
          <ArrowLeft size={16} strokeWidth={1.75} />
        </IconButton>
        <input
          value={name}
          aria-label={t("list.colName")}
          onChange={(e) => {
            setName(e.target.value);
            markDirty();
          }}
          className="kp-quiet h-8 min-w-[160px] max-w-[360px] flex-1 text-[15px] font-semibold"
        />
        <Switch className="gap-2 text-[13px] text-text-2" checked={enabled} onChange={handleToggleEnabled} label={t("canvas.enabledLabel")} />
        <Switch
          className="gap-2 text-[13px] text-text-2"
          checked={dryRun}
          onChange={(v) => {
            setDryRun(v);
            markDirty();
          }}
          label={t("canvas.dryRunLabel")}
        />
        {dryRun && <Badge tone="amber">{t("list.dryRunBadge")}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {saveError ? (
            <span role="alert" className="text-[13px] text-danger">{saveError}</span>
          ) : dirty ? (
            <span className="text-[13px] text-text-3">{t("canvas.unsaved")}</span>
          ) : (
            <span className="hidden items-center gap-1 text-[13px] text-text-3 sm:inline-flex">
              <Check size={14} /> {t("canvas.saved")}
            </span>
          )}
          {isArmed ? (
            <>
              <Button variant="ghost" size="sm" onClick={disarm}>
                {t("canvas.disarm")}
              </Button>
              <Button variant="danger" size="sm" onClick={handleDelete}>
                <Trash2 size={14} />
                {t("canvas.clickAgainToDelete")}
              </Button>
            </>
          ) : (
            <IconButton aria-label={t("canvas.deleteWorkflow")} title={t("canvas.deleteWorkflow")} onClick={handleDelete} className="hover:bg-danger-soft hover:text-danger">
              <Trash2 size={16} strokeWidth={1.75} />
            </IconButton>
          )}
          <Button variant="primary" size="sm" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? t("canvas.saving") : t("canvas.save")}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <NodePalette onAdd={handleAddNode} />
        <div className="min-w-0 flex-1 bg-surface-2">
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
            fitViewOptions={{ maxZoom: 1, padding: 0.3 }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--border2)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {selectedNode ? (
          <NodeConfigPanel
            node={selectedNode}
            onChangeConfig={handleChangeConfig}
            onChangeName={handleChangeName}
            onDelete={handleDeleteNode}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : (
          <RunHistoryPanel workflowId={workflowId} refreshSignal={runsRefreshSignal} />
        )}
      </div>
    </div>
  );
}

/** Two-step delete that auto-disarms after a few seconds, so a stray first click can't linger armed. */
function useDeleteArm() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  return { isArmed: armed, arm: () => setArmed(true), disarm: () => setArmed(false) };
}
