import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Map as MapIcon, Plus } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { IssueTypeIcon } from "@kompast/ui/IssueTypeIcon";
import { EmptyState, SkeletonRows } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import { getRoadmapFn } from "@/lib/server-fns/roadmap";
import { useWorkbench } from "@/components/shell/WorkbenchContext";
import { cn } from "@/lib/cn";
import { formatShortDate, useIntlLocale } from "./project-shared";

type Epic = Awaited<ReturnType<typeof getRoadmapFn>>[number];

const MONTH_WIDTH = 120;

function monthStart(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

/**
 * Jira-lite roadmap: a list of epics on the left, a month-scale timeline on
 * the right with each dated epic drawn as a bar (fill = share of children
 * done). Epics without both dates stay in the list with a "No dates" hint —
 * nothing is invented for them.
 */
export function RoadmapView({ projectId, projectKey, teamId, epicTypeId }: { projectId: string; projectKey: string; teamId: string; epicTypeId: string | undefined }) {
  const { t } = useTranslation("board");
  const locale = useIntlLocale();
  const { openCreateIssue } = useWorkbench();
  const [epics, setEpics] = useState<Epic[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    return getRoadmapFn({ data: projectId })
      .then(setEpics)
      .catch((err) => setError(err instanceof Error ? err.message : t("genericError")));
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const createEpic = () => openCreateIssue({ projectId, typeId: epicTypeId, onCreated: () => refresh() });

  const range = useMemo(() => {
    const dated = (epics ?? []).filter((e) => e.startDate && e.dueDate);
    const now = new Date();
    let min = monthStart(now);
    let max = addMonths(min, 6);
    for (const e of dated) {
      const s = monthStart(new Date(e.startDate!));
      const d = addMonths(monthStart(new Date(e.dueDate!)), 1);
      if (s < min) min = s;
      if (d > max) max = d;
    }
    const months: Date[] = [];
    for (let m = min; m < max; m = addMonths(m, 1)) months.push(m);
    return { min, max, months };
  }, [epics]);

  if (error) return <p className="m-6 rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{error}</p>;
  if (epics === null) return <SkeletonRows rows={5} className="p-6" />;

  if (epics.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<MapIcon size={18} />}
          title={t("roadmap.noEpicsHeading")}
          description={t("roadmap.noEpicsSubtext")}
          action={
            <Button variant="primary" onClick={createEpic} disabled={!epicTypeId}>
              <Plus size={15} /> {t("roadmap.createEpicButton")}
            </Button>
          }
        />
      </div>
    );
  }

  const totalMs = range.max.getTime() - range.min.getTime();
  const timelineWidth = range.months.length * MONTH_WIDTH;
  // Percent of the timeline, so the grid stretches to fill wide screens and
  // only scrolls once months would get narrower than MONTH_WIDTH.
  const pos = (d: Date) => ((d.getTime() - range.min.getTime()) / totalMs) * 100;
  const today = pos(new Date());
  const hasUndated = epics.some((e) => !e.startDate || !e.dueDate);

  return (
    <div className="kp-board-roadmap flex flex-col gap-3 px-4 pb-12 pt-4 sm:px-6">
      <div className="flex items-center gap-3">
        <p className="type-small text-text-2">{hasUndated ? t("roadmap.noDatesHint") : null}</p>
        <Button variant="primary" size="sm" className="ml-auto" onClick={createEpic} disabled={!epicTypeId}>
          <Plus size={15} /> {t("roadmap.createEpicButton")}
        </Button>
      </div>

      <div className="flex overflow-hidden rounded-[10px] border border-border bg-surface">
        {/* Epic list */}
        <div className="w-[300px] flex-none border-r border-border max-sm:w-[220px]">
          <div className="flex h-10 items-center border-b border-border bg-surface-2 px-3 type-label-overline text-text-2">
            {t("roadmap.epicsHeading")}
          </div>
          {epics.map((epic) => {
            const pct = epic.childCount === 0 ? 0 : Math.round((epic.doneCount / epic.childCount) * 100);
            return (
              <Link
                key={epic.id}
                to="/issues/$teamId/$projectKey/$issueKeySeq"
                params={{ teamId, projectKey, issueKeySeq: String(epic.keySeq) }}
                className="flex h-14 flex-col justify-center gap-1 border-b border-border px-3 last:border-b-0 hover:bg-surface-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <IssueTypeIcon type={{ name: "Epic", hierarchyLevel: 0 }} size={16} />
                  <span className="type-key flex-none text-text-3">
                    {projectKey}-{epic.keySeq}
                  </span>
                  <span className="truncate text-[14px] font-medium text-text">{epic.title}</span>
                </span>
                <span className="flex items-center gap-2 pl-6">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <span className="block h-full rounded-full bg-green" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="flex-none text-[11.5px] tabular-nums text-text-3">{t("roadmap.doneOf", { done: epic.doneCount, total: epic.childCount })}</span>
                </span>
              </Link>
            );
          })}
        </div>

        {/* Timeline */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="relative w-full" style={{ minWidth: timelineWidth }}>
            <div className="flex h-10 border-b border-border bg-surface-2">
              {range.months.map((m) => (
                <div key={m.toISOString()} className="min-w-0 flex-1 border-r border-border px-2 pt-3 text-[12px] font-medium text-text-2 last:border-r-0">
                  {m.toLocaleDateString(locale, { month: "short", year: m.getMonth() === 0 || m === range.months[0] ? "numeric" : undefined })}
                </div>
              ))}
            </div>
            <div className="pointer-events-none absolute inset-0 flex" aria-hidden>
              {range.months.map((m) => (
                <div key={m.toISOString()} className="h-full min-w-0 flex-1 border-r border-border/70 last:border-r-0" />
              ))}
            </div>
            {today >= 0 && today <= 100 && (
              <div className="pointer-events-none absolute bottom-0 top-10 z-[1] w-px bg-accent" style={{ left: `${today}%` }} title={t("roadmap.today")}>
                <span className="absolute -left-[3px] -top-[3px] h-[7px] w-[7px] rounded-full bg-accent" />
              </div>
            )}
            {epics.map((epic) => {
              const dated = epic.startDate && epic.dueDate;
              const pct = epic.childCount === 0 ? 0 : Math.round((epic.doneCount / epic.childCount) * 100);
              if (!dated) {
                return (
                  <div key={epic.id} className="relative flex h-14 items-center border-b border-border px-3 last:border-b-0">
                    <span className="rounded-[4px] border border-dashed border-border-2 px-2 py-0.5 text-[12px] text-text-3">{t("roadmap.noDates")}</span>
                  </div>
                );
              }
              const left = pos(new Date(epic.startDate!));
              const right = pos(new Date(new Date(epic.dueDate!).getTime() + 86_400_000));
              const width = Math.max(0.8, right - left);
              return (
                <div key={epic.id} className="relative h-14 border-b border-border last:border-b-0">
                  <div
                    className={cn("absolute top-1/2 flex h-7 -translate-y-1/2 items-center overflow-hidden rounded-[6px] bg-violet-soft ring-1 ring-inset ring-violet/30")}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${epic.title} · ${formatShortDate(epic.startDate, locale)} – ${formatShortDate(epic.dueDate, locale)} · ${pct}%`}
                  >
                    <span className="absolute inset-y-0 left-0 bg-violet/25" style={{ width: `${pct}%` }} />
                    <span className="relative truncate px-2 text-[12px] font-medium text-violet">{epic.title}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
