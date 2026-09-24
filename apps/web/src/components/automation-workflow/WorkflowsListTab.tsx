import { Switch } from "@kompast/ui/Switch";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { CalendarClock, Plus, Zap } from "lucide-react";
import { Badge, type BadgeTone } from "@kompast/ui/Badge";
import { Button } from "@kompast/ui/Button";
import { EmptyState, SkeletonRows } from "@kompast/ui/EmptyState";
import { useToast } from "@kompast/ui/Toast";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listWorkflowsFn, createWorkflowFn, updateWorkflowFn } from "@/lib/server-fns/automation-workflows";
import { cn } from "@/lib/cn";
import { getNodeTypeConfigs, type AutomationNodeType } from "./node-type-config";
import { newNodeId } from "./graph-serialize";

type Workflow = Awaited<ReturnType<typeof listWorkflowsFn>>[number];

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };
const RUN_TONE: Record<string, BadgeTone> = { running: "accent", completed: "green", failed: "danger" };

function relative(date: Date, locale: string) {
  const diff = (new Date(date).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(date).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}


export function WorkflowsListTab({ projectId, teamId, projectKey }: { projectId: string; teamId: string; projectKey: string }) {
  const { t, i18n } = useTranslation("workflow");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
  const navigate = useNavigate();
  const toast = useToast();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nodeTypes = getNodeTypeConfigs(t);

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
      await navigate({ to: "/workflows/$teamId/$projectKey/$workflowId", params: { teamId, projectKey, workflowId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("list.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function toggle(wf: Workflow, enabled: boolean) {
    setWorkflows((list) => list?.map((w) => (w.id === wf.id ? { ...w, enabled } : w)) ?? null);
    try {
      await updateWorkflowFn({ data: { workflowId: wf.id, projectId, enabled } });
    } catch (err) {
      setWorkflows((list) => list?.map((w) => (w.id === wf.id ? { ...w, enabled: !enabled } : w)) ?? null);
      toast.show({ tone: "error", title: t("canvas.toggleFailed"), description: err instanceof Error ? err.message : undefined });
    }
  }

  const createForm = (
    <form
      className="flex w-full max-w-[520px] flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        createAndOpen();
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("list.createPlaceholder")}
        aria-label={t("list.newWorkflowNameLabel")}
        className="kp-input min-w-[220px] flex-1"
      />
      <Button type="submit" variant="primary" disabled={creating || !name.trim()}>
        <Plus size={15} strokeWidth={2} />
        {t("list.newWorkflowButton")}
      </Button>
    </form>
  );

  if (workflows === null) return <SkeletonRows rows={4} />;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-[640px] type-body text-text-2">{t("list.subtitle")}</p>
        {workflows.length > 0 && createForm}
      </div>
      {error && <p role="alert" className="rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}

      {workflows.length === 0 ? (
        <EmptyState icon={<Zap size={18} />} title={t("list.emptyTitle")} description={t("list.emptyBody")} action={createForm} />
      ) : (
        <div className="overflow-x-auto rounded-[8px] border border-border bg-surface">
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-[14px]">
            <thead className="bg-surface-2">
              <tr className="text-left text-[12.5px] text-text-3">
                <th className="h-9 w-[64px] border-b border-border px-3 font-medium">{t("list.colStatus")}</th>
                <th className="h-9 border-b border-border px-2 font-medium">{t("list.colName")}</th>
                <th className="h-9 border-b border-border px-2 font-medium">{t("list.colTrigger")}</th>
                <th className="h-9 w-[200px] border-b border-border px-2 pr-3 font-medium">{t("list.colLastRun")}</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((wf) => {
                const trigger = wf.trigger;
                const triggerMeta = trigger ? nodeTypes[trigger.type as AutomationNodeType] : null;
                return (
                  <tr key={wf.id} className="group/row hover:bg-surface-2">
                    <td className="h-12 border-b border-border px-3">
                      <Switch srOnlyLabel checked={wf.enabled} onChange={(v) => toggle(wf, v)} label={t("list.toggleLabel", { name: wf.name })} />
                    </td>
                    <td className="h-12 border-b border-border px-2">
                      <Link
                        to="/workflows/$teamId/$projectKey/$workflowId"
                        params={{ teamId, projectKey, workflowId: wf.id }}
                        className="flex min-w-0 flex-col"
                      >
                        <span className="flex items-center gap-2">
                          <span className={cn("truncate font-medium hover:text-accent-text hover:underline", !wf.enabled && "text-text-2")}>{wf.name}</span>
                          {wf.dryRun && <Badge tone="amber">{t("list.dryRunBadge")}</Badge>}
                        </span>
                        <span className="text-[12px] text-text-3">{t("list.updated", { when: relative(wf.updatedAt, intlLocale) })}</span>
                      </Link>
                    </td>
                    <td className="h-12 border-b border-border px-2 text-[13.5px] text-text-2">
                      {trigger && triggerMeta ? (
                        <span className="inline-flex items-center gap-1.5">
                          {trigger.type === "trigger_schedule" ? (
                            <CalendarClock size={15} className="flex-none text-accent" />
                          ) : (
                            <Zap size={15} className="flex-none text-accent" />
                          )}
                          <span className="truncate">{triggerMeta.summary(trigger.config)}</span>
                        </span>
                      ) : (
                        <span className="text-text-3">–</span>
                      )}
                    </td>
                    <td className="h-12 border-b border-border px-2 pr-3 text-[13px]">
                      {wf.lastRun ? (
                        <span className="inline-flex items-center gap-2">
                          <Badge tone={RUN_TONE[wf.lastRun.status] ?? "neutral"}>{t(`list.run_${wf.lastRun.status}`)}</Badge>
                          <span className="text-text-3">{relative(wf.lastRun.createdAt, intlLocale)}</span>
                        </span>
                      ) : (
                        <span className="text-text-3">{t("list.never")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
