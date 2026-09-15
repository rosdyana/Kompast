import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "@kompast/ui/Badge";
import { Button } from "@kompast/ui/Button";
import { useTranslation } from "@kompast/i18n";
import { listWorkflowsFn, createWorkflowFn } from "@/lib/server-fns/automation-workflows";
import { newNodeId } from "./graph-serialize";

type Workflow = Awaited<ReturnType<typeof listWorkflowsFn>>[number];

export function WorkflowsListTab({ projectId, teamId, projectKey }: { projectId: string; teamId: string; projectKey: string }) {
  const { t } = useTranslation("workflow");
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setWorkflows(await listWorkflowsFn({ data: projectId }));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function createAndOpen() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { workflowId } = await createWorkflowFn({
        data: {
          projectId,
          name: name.trim(),
          nodes: [{ id: newNodeId(), type: "trigger_event", config: { eventType: "issue.created" }, position: { x: 0, y: 0 } }],
          edges: [],
        },
      });
      setName("");
      window.location.href = `/workflows/${teamId}/${projectKey}/${workflowId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("list.createFailed"));
      setCreating(false);
    }
  }

  if (workflows === null) return <p className="p-6 type-body text-text-3">{t("list.loading")}</p>;

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <label className="flex flex-col gap-1 text-[11.5px] text-text-3">
          {t("list.newWorkflowNameLabel")}
          <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[12.5px]" />
        </label>
        <Button variant="primary" onClick={createAndOpen} disabled={creating || !name.trim()}>
          {t("list.newWorkflowButton")}
        </Button>
        {error && <p className="type-body text-danger">{error}</p>}
      </div>

      <div className="flex flex-col gap-2">
        {workflows.length === 0 && <p className="type-body text-text-3">{t("list.empty")}</p>}
        {workflows.map((wf) => (
          <Link
            key={wf.id}
            to="/workflows/$teamId/$projectKey/$workflowId"
            params={{ teamId, projectKey, workflowId: wf.id }}
            className="flex items-center gap-2 rounded-xl border border-border bg-surface p-3.5 hover:bg-surface-3"
          >
            <span className="type-body font-semibold">{wf.name}</span>
            <Badge tone={wf.enabled ? "green" : "neutral"}>{wf.enabled ? t("list.enabledBadge") : t("list.disabledBadge")}</Badge>
            {wf.dryRun && <Badge tone="amber">{t("list.dryRunBadge")}</Badge>}
          </Link>
        ))}
      </div>
    </div>
  );
}
