import { useEffect, useState } from "react";
import { ChevronRight, History } from "lucide-react";
import { Badge, type BadgeTone } from "@kompast/ui/Badge";
import { SkeletonRows } from "@kompast/ui/EmptyState";
import { useTranslation, type SupportedLocale } from "@kompast/i18n";
import { listWorkflowRunsFn, getWorkflowRunFn } from "@/lib/server-fns/automation-workflows";
import { cn } from "@/lib/cn";

type Run = Awaited<ReturnType<typeof listWorkflowRunsFn>>[number];
type RunDetail = Awaited<ReturnType<typeof getWorkflowRunFn>>;

const INTL_LOCALE: Record<SupportedLocale, string> = { en: "en-US", id: "id-ID", "zh-Hant": "zh-Hant-TW" };
const RUN_STATUS_TONE: Record<string, BadgeTone> = { running: "accent", completed: "green", failed: "danger" };
const STEP_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "neutral",
  processing: "accent",
  waiting: "violet",
  succeeded: "green",
  failed: "danger",
  skipped_max_depth: "neutral",
};

export function RunHistoryPanel({ workflowId, refreshSignal }: { workflowId: string; refreshSignal: number }) {
  const { t, i18n } = useTranslation("workflow");
  const intlLocale = INTL_LOCALE[i18n.language as SupportedLocale] ?? "en-US";
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
    setDetail(null);
    setDetail(await getWorkflowRunFn({ data: runId }));
  }

  return (
    <aside aria-label={t("runHistory.heading")} className="hidden h-full w-[320px] flex-none flex-col border-l border-border bg-surface lg:flex">
      <div className="flex h-12 flex-none items-center gap-2 border-b border-border px-4">
        <History size={16} className="text-text-3" />
        <p className="type-headline">{t("runHistory.heading")}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {runs === null && <SkeletonRows rows={4} className="p-2" />}
        {runs !== null && runs.length === 0 && <p className="px-2 py-6 text-center text-[13.5px] text-text-3">{t("runHistory.empty")}</p>}
        {runs?.map((run) => {
          const open = expandedRunId === run.id;
          return (
            <div key={run.id} className="rounded-[6px]">
              <button
                type="button"
                onClick={() => toggleRun(run.id)}
                aria-expanded={open}
                className="flex h-9 w-full items-center gap-2 rounded-[6px] px-2 text-left hover:bg-surface-3"
              >
                <ChevronRight size={14} className={cn("flex-none text-text-3 transition-transform", open && "rotate-90")} />
                <Badge tone={RUN_STATUS_TONE[run.status] ?? "neutral"}>{t(`list.run_${run.status}`, { defaultValue: run.status })}</Badge>
                <span className="ml-auto text-[12px] tabular-nums text-text-3">
                  {new Date(run.createdAt).toLocaleString(intlLocale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </button>
              {open && (
                <div className="mb-1 ml-6 flex flex-col gap-1 border-l border-border py-1 pl-3">
                  {!detail && <SkeletonRows rows={2} />}
                  {detail?.steps.map((step) => (
                    <div key={step.id} className="flex flex-col gap-0.5 py-0.5">
                      <span className="flex items-center gap-2 text-[12.5px]">
                        <Badge tone={STEP_STATUS_TONE[step.status] ?? "neutral"}>{step.status}</Badge>
                        <span className="truncate text-text">{step.nodeName || step.nodeType}</span>
                      </span>
                      {step.error && <span className="text-[12px] text-danger">{step.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
