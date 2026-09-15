import { useEffect, useState } from "react";
import { Badge, type BadgeTone } from "@kompast/ui/Badge";
import { useTranslation } from "@kompast/i18n";
import { listWorkflowRunsFn, getWorkflowRunFn } from "@/lib/server-fns/automation-workflows";

type Run = Awaited<ReturnType<typeof listWorkflowRunsFn>>[number];
type RunDetail = Awaited<ReturnType<typeof getWorkflowRunFn>>;

const RUN_STATUS_TONE: Record<string, BadgeTone> = { running: "accent", completed: "green", failed: "amber" };
const STEP_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "neutral",
  processing: "accent",
  waiting: "violet",
  succeeded: "green",
  failed: "amber",
  skipped_max_depth: "neutral",
};

export function RunHistoryPanel({ workflowId, refreshSignal }: { workflowId: string; refreshSignal: number }) {
  const { t } = useTranslation("workflow");
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);

  useEffect(() => {
    listWorkflowRunsFn({ data: workflowId }).then(setRuns);
  }, [workflowId, refreshSignal]);

  async function toggleRun(runId: string) {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      setDetail(null);
      return;
    }
    setExpandedRunId(runId);
    setDetail(await getWorkflowRunFn({ data: runId }));
  }

  if (runs === null) return <p className="p-3 type-body text-text-3">{t("runHistory.loading")}</p>;

  return (
    <div className="flex h-full w-80 flex-none flex-col gap-2 overflow-y-auto border-l border-border bg-surface p-3">
      <p className="type-headline">{t("runHistory.heading")}</p>
      {runs.length === 0 && <p className="type-body text-text-3">{t("runHistory.empty")}</p>}
      {runs.map((run) => (
        <div key={run.id} className="rounded-[9px] border border-border p-2">
          <button onClick={() => toggleRun(run.id)} className="flex w-full items-center gap-2 text-left">
            <Badge tone={RUN_STATUS_TONE[run.status] ?? "neutral"}>{run.status}</Badge>
            <span className="text-[11px] text-text-3">{new Date(run.createdAt).toLocaleString()}</span>
          </button>
          {expandedRunId === run.id && detail && (
            <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
              {detail.steps.map((step) => (
                <div key={step.id} className="flex items-center gap-2 text-[11px] text-text-3">
                  <Badge tone={STEP_STATUS_TONE[step.status] ?? "neutral"}>{step.status}</Badge>
                  <span>{step.nodeName || step.nodeType}</span>
                  {step.error && <span className="text-danger">{step.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
