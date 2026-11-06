import { useEffect, useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { useTranslation } from "@kompast/i18n";
import { getJiraReconcileFn, listJiraAttachmentsLeftFn } from "@/lib/server-fns/jira-migration";
import { cn } from "@/lib/cn";
import type { JiraMigrationRow } from "./ConnectStep";
import { StepHeading } from "./shared";

/**
 * The reconciliation report, the Finish flow and the completed view. The report is read on demand (getJiraReconcileFn),
 * since its differences can run to 20,000 entries and only this panel needs them.
 */

export type ReconcileReport = NonNullable<Awaited<ReturnType<typeof getJiraReconcileFn>>>;
type ReconcileCategoryName = keyof ReconcileReport["counts"];

/** The run fields the panels read. The wizard's run list (getJiraMigrationFn) has them all. */
export interface RunLike {
  id: string;
  config: unknown;
  status: string;
  counts: unknown;
  notes: unknown;
  createdAt: Date | string;
  completedAt: Date | string | null;
}

export interface ProjectRef {
  teamId: string | null;
  key: string;
}

const CATEGORIES = [
  "issues",
  "keyNumbers",
  "title",
  "status",
  "type",
  "priority",
  "assignee",
  "parent",
  "sprint",
  "comments",
  "worklogs",
  "attachments",
  "links",
  "watchers",
  "fields",
  "inlineMedia",
  "sprints",
  "missingInJira",
] as const;

const REASONS = [
  "edited-in-kompast",
  "parent-not-imported",
  "not-migrated",
  "copy-failed",
  "outside-project",
  "renumbered",
  "deleted",
  "moved",
  "unmapped-watchers",
  "watchers-unverified",
  "value-not-converted",
  "unmatched-media",
  "parallel-active",
] as const;
type ReasonCode = (typeof REASONS)[number];

/** A run's mode: sync and reconcile by name, anything else a full import (runs from before modes existed are full). */
export function runModeOf(run: { config: unknown } | null | undefined): "sync" | "full" | "reconcile" {
  const mode = (run?.config as { mode?: unknown } | null)?.mode;
  return mode === "sync" ? "sync" : mode === "reconcile" ? "reconcile" : "full";
}

/** One cell of a CSV. Quoted when it must be, and a leading =, +, - or @ is neutralised so a spreadsheet can't run it. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The newest completed reconcile that finished after the last sync, or null: the one Finish needs. */
export function freshReconcileOf(runs: RunLike[], lastSyncedAt: Date | string | null | undefined): RunLike | null {
  if (!lastSyncedAt) return null;
  const synced = new Date(lastSyncedAt).getTime();
  return runs.find((r) => runModeOf(r) === "reconcile" && r.status === "completed" && !!r.completedAt && new Date(r.completedAt).getTime() > synced) ?? null;
}

function unexplainedOf(report: ReconcileReport): number {
  return Object.values(report.counts).reduce((sum, t) => sum + t.unexplained, 0);
}

function isCategory(value: string): value is ReconcileCategoryName & (typeof CATEGORIES)[number] {
  return (CATEGORIES as readonly string[]).includes(value);
}

function isReasonCode(value: string): value is ReasonCode {
  return (REASONS as readonly string[]).includes(value);
}

/** A JIRA issue key ("ZTRD-12"): the only keys that have a JIRA page to link to. */
function isIssueKey(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(value);
}

function kompastIssueHref(projectRef: ProjectRef, keySeq: number): string {
  return `/issues/${projectRef.teamId ?? "none"}/${projectRef.key}/${keySeq}`;
}

function kompastBoardHref(projectRef: ProjectRef): string {
  return `/projects/${projectRef.teamId ?? "none"}/${projectRef.key}`;
}

/** Downloads the report as one CSV: every difference, then the files left in JIRA, with a type column telling them apart. */
export async function downloadReportCsv(report: ReconcileReport, migration: JiraMigrationRow): Promise<void> {
  const site = migration.siteUrl.replace(/\/+$/, "");
  const header = ["type", "category", "issue", "JIRA", "Kompast", "reason", "detail", "link"];
  const rows: unknown[][] = report.notes.differences.map((d) => [
    "difference",
    d.category,
    d.issueKey,
    d.jira,
    d.kompast,
    d.reason,
    d.detail ?? "",
    isIssueKey(d.issueKey) ? `${site}/browse/${d.issueKey}` : "",
  ]);
  const left = await listJiraAttachmentsLeftFn({ data: migration.projectId });
  for (const r of left) {
    rows.push(["file left in JIRA", "attachments", r.issueKey, r.fileName, r.status, "", r.error ?? "", r.sourceUrl ?? ""]);
  }
  const csv = [header, ...rows].map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${migration.jiraProjectKey}-completeness.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Downloads the files still in JIRA as a CSV. The list is read on demand, so the button needs no state of its own. */
export function LeftInJiraButton({ projectId, jiraProjectKey }: { projectId: string; jiraProjectKey: string }) {
  const { t } = useTranslation("board");
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const rows = await listJiraAttachmentsLeftFn({ data: projectId });
      const header = ["Issue key", "File name", "Size (bytes)", "Status", "Error", "JIRA link"];
      const body = rows.map((r) => [r.issueKey, r.fileName, r.sizeBytes, r.status, r.error, r.sourceUrl]);
      const csv = [header, ...body].map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${jiraProjectKey}-files-left-in-jira.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="outline" onClick={download} disabled={busy}>
      {t("jiraMigration.run.leftInJira")}
    </Button>
  );
}

/** Every category with any activity, with its JIRA and Kompast counts and how many differences are explained or not. */
function ReconcileSummary({ report }: { report: ReconcileReport }) {
  const { t } = useTranslation("board");
  const unexplained = unexplainedOf(report);
  const rows = Object.entries(report.counts).filter(([, c]) => c.jira || c.kompast || c.explained || c.unexplained);
  return (
    <div>
      <p className={cn("type-body font-medium", unexplained === 0 ? "text-accent-text" : "text-danger")}>
        {unexplained === 0 ? t("jiraMigration.finish.everythingMatches") : t("jiraMigration.finish.differencesNeedLook", { count: unexplained })}
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="type-small tabular-nums">
          <thead>
            <tr className="text-left text-text-3">
              <th className="pr-4 font-normal">{t("jiraMigration.finish.colCategory")}</th>
              <th className="pr-4 text-right font-normal">{t("jiraMigration.finish.colJira")}</th>
              <th className="pr-4 text-right font-normal">{t("jiraMigration.finish.colKompast")}</th>
              <th className="pr-4 text-right font-normal">{t("jiraMigration.finish.colExplained")}</th>
              <th className="text-right font-normal">{t("jiraMigration.finish.colUnexplained")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([category, c]) => (
              <tr key={category} className="text-text-2">
                <td className="pr-4 py-0.5">{isCategory(category) ? t(`jiraMigration.finish.categories.${category}`) : category}</td>
                <td className="pr-4 text-right">{c.jira}</td>
                <td className="pr-4 text-right">{c.kompast}</td>
                <td className="pr-4 text-right">{c.explained}</td>
                <td className={cn("text-right", c.unexplained > 0 && "text-danger")}>{c.unexplained}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The differences, filterable by explained or not and by category, each with its Kompast and JIRA links. */
function DifferenceList({ report, migration, projectRef }: { report: ReconcileReport; migration: JiraMigrationRow; projectRef: ProjectRef | null }) {
  const { t } = useTranslation("board");
  const [kind, setKind] = useState<"all" | "explained" | "unexplained">("all");
  const [category, setCategory] = useState<string>("all");
  const site = migration.siteUrl.replace(/\/+$/, "");
  const all = report.notes.differences;
  const shown = all.filter((d) => (kind === "all" ? true : kind === "explained" ? d.reason !== "unexplained" : d.reason === "unexplained")).filter((d) => category === "all" || d.category === category);
  const LIMIT = 200;
  const visible = shown.slice(0, LIMIT);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded-[6px] border border-border bg-surface px-2 py-1 type-small text-text" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label={t("jiraMigration.finish.filterAll")}>
          <option value="all">{t("jiraMigration.finish.filterAll")}</option>
          <option value="explained">{t("jiraMigration.finish.filterExplained")}</option>
          <option value="unexplained">{t("jiraMigration.finish.filterUnexplained")}</option>
        </select>
        <select className="rounded-[6px] border border-border bg-surface px-2 py-1 type-small text-text" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t("jiraMigration.finish.filterCategory")}>
          <option value="all">{t("jiraMigration.finish.filterAllCategories")}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`jiraMigration.finish.categories.${c}`)}
            </option>
          ))}
        </select>
        <span className="type-small text-text-3">{t("jiraMigration.finish.showing", { shown: visible.length, total: shown.length })}</span>
      </div>
      {visible.length > 0 && (
        <ul className="mt-2 flex max-h-[420px] flex-col gap-2 overflow-y-auto">
          {visible.map((d, i) => {
            const explained = d.reason !== "unexplained";
            const code = d.reason.startsWith("explained:") ? d.reason.slice("explained:".length) : "";
            const keySeq = report.keySeqs[d.issueKey];
            return (
              <li key={`${d.category}-${d.issueKey}-${i}`} className="rounded-[6px] border border-border px-3 py-2 type-small">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium text-text">{isCategory(d.category) ? t(`jiraMigration.finish.categories.${d.category}`) : d.category}</span>
                  <span className={cn(explained ? "text-text-2" : "text-danger")}>
                    {explained && isReasonCode(code) ? t("jiraMigration.finish.reasonExplained", { reason: t(`jiraMigration.finish.reasons.${code}`) }) : explained ? t("jiraMigration.finish.reasonExplained", { reason: code }) : t("jiraMigration.finish.reasonUnexplained")}
                  </span>
                  {isIssueKey(d.issueKey) && (
                    <span className="flex gap-2">
                      {projectRef && keySeq !== undefined && (
                        <a className="text-accent-text hover:underline" href={kompastIssueHref(projectRef, keySeq)}>
                          {t("jiraMigration.finish.openKompast")}
                        </a>
                      )}
                      <a className="text-accent-text hover:underline" href={`${site}/browse/${d.issueKey}`} target="_blank" rel="noreferrer">
                        {t("jiraMigration.finish.openJira")}
                      </a>
                    </span>
                  )}
                  <span className="text-text-3">{d.issueKey}</span>
                </div>
                <div className="mt-0.5 text-text-2">
                  {t("jiraMigration.finish.colValues")}: {String(d.jira ?? "—")} → {String(d.kompast ?? "—")}
                  {d.detail ? <span className="text-text-3"> · {d.detail}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {report.notes.truncated > 0 && <p className="mt-2 type-small text-text-3">{t("jiraMigration.finish.truncated", { count: report.notes.truncated })}</p>}
    </div>
  );
}

/**
 * The Finish flow, shown from the synced Run panel. Finish needs a completeness check newer than the last sync; with
 * unexplained differences, the user must tick that they reviewed them.
 */
export function FinishPanel({
  migration,
  runs,
  projectRef,
  canManage,
  busy,
  onCheckBeforeFinish,
  onFinish,
  onClose,
}: {
  migration: JiraMigrationRow;
  runs: RunLike[];
  projectRef: ProjectRef | null;
  canManage: boolean;
  busy: boolean;
  onCheckBeforeFinish: () => void;
  onFinish: (acknowledgedDifferences: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("board");
  const fresh = freshReconcileOf(runs, migration.lastSyncedAt);
  const freshId = fresh?.id ?? null;
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!freshId) {
      setReport(null);
      return;
    }
    let live = true;
    getJiraReconcileFn({ data: { migrationId: migration.id } })
      .then((r) => {
        if (live) setReport(r);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [freshId, migration.id]);

  const unexplained = report ? unexplainedOf(report) : 0;

  return (
    <section className="mt-6 max-w-[860px] rounded-[8px] border border-border p-4">
      <StepHeading title={t("jiraMigration.finish.heading")} description={t("jiraMigration.finish.intro")} />
      {!fresh ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="type-small text-text-2">{t("jiraMigration.finish.needCheck")}</p>
          {canManage && (
            <div>
              <Button variant="primary" onClick={onCheckBeforeFinish} disabled={busy}>
                {t("jiraMigration.run.checkBeforeFinish")}
              </Button>
            </div>
          )}
        </div>
      ) : !report ? (
        <p className="mt-3 type-small text-text-3">{t("jiraMigration.finish.loading")}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          <ReconcileSummary report={report} />
          <DifferenceList report={report} migration={migration} projectRef={projectRef} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void downloadReportCsv(report, migration)} disabled={busy}>
              {t("jiraMigration.finish.downloadCsv")}
            </Button>
            {canManage && (
              <Button
                variant="primary"
                onClick={() => {
                  setAcknowledged(false);
                  setConfirmOpen(true);
                }}
                disabled={busy}
              >
                {t("jiraMigration.finish.finishButton")}
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              {t("jiraMigration.finish.close")}
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t("jiraMigration.finish.confirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={busy || (unexplained > 0 && !acknowledged)}
              onClick={() => {
                setConfirmOpen(false);
                onFinish(unexplained > 0 && acknowledged);
              }}
            >
              {t("jiraMigration.finish.confirm")}
            </Button>
          </>
        }
      >
        <p className="type-small text-text-2">{t("jiraMigration.finish.confirmBody")}</p>
        {unexplained > 0 && (
          <label className="mt-3 flex items-center gap-2 type-small text-text-2">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            {t("jiraMigration.finish.acknowledge")}
          </label>
        )}
      </Dialog>
    </section>
  );
}

/** The local checklist's ticks, kept per migration in this browser. Nothing about it is server state. */
function useChecklist(storageKey: string) {
  const [checked, setChecked] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      setChecked(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setChecked([]);
    }
  }, [storageKey]);
  function toggle(item: string) {
    setChecked((prev) => {
      const next = prev.includes(item) ? prev.filter((x) => x !== item) : [...prev, item];
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage is full or blocked: the tick still shows for this visit.
      }
      return next;
    });
  }
  return { checked, toggle };
}

/**
 * The completed view: when it finished, the last reconciliation (read-only), and a checklist for what the team still
 * has to do. Ticks are local to this browser.
 */
export function CompletedView({
  migration,
  projectRef,
  filesLeft,
  formerCount,
}: {
  migration: JiraMigrationRow;
  projectRef: ProjectRef | null;
  filesLeft: number;
  formerCount: number;
}) {
  const { t } = useTranslation("board");
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { checked, toggle } = useChecklist(`jira-migration-finish-checklist:${migration.id}`);
  const site = migration.siteUrl.replace(/\/+$/, "");

  useEffect(() => {
    let live = true;
    getJiraReconcileFn({ data: { migrationId: migration.id } })
      .then((r) => {
        if (live) {
          setReport(r);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (live) setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [migration.id]);

  const date = migration.updatedAt ? new Date(migration.updatedAt).toLocaleDateString(undefined, { dateStyle: "medium" }) : "";
  const items: { id: string; label: string; link?: { href: string; text: string; external: boolean } }[] = [
    { id: "readOnly", label: t("jiraMigration.finish.checkReadOnly"), link: { href: `${site}/plugins/servlet/project-config/${migration.jiraProjectKey}/permissions`, text: t("jiraMigration.finish.checkReadOnlyLink"), external: true } },
    ...(projectRef ? [{ id: "announce", label: t("jiraMigration.finish.checkAnnounce"), link: { href: kompastBoardHref(projectRef), text: t("jiraMigration.finish.checkAnnounceLink"), external: false } }] : []),
    { id: "former", label: t("jiraMigration.finish.checkFormer", { count: formerCount }) },
    { id: "filesLeft", label: t("jiraMigration.finish.checkFilesLeft", { count: filesLeft }) },
  ];

  return (
    <div>
      <StepHeading title={t("jiraMigration.finish.finishedHeading", { date })} description={t("jiraMigration.finish.tokenDeleted")} />

      <section className="mt-4 max-w-[860px]">
        <h3 className="type-small font-medium text-text">{t("jiraMigration.finish.lastReconciliation")}</h3>
        {!loaded ? (
          <p className="mt-2 type-small text-text-3">{t("jiraMigration.finish.loading")}</p>
        ) : !report ? (
          <p className="mt-2 type-small text-text-3">{t("jiraMigration.finish.noneYet")}</p>
        ) : (
          <div className="mt-2 flex flex-col gap-4">
            <ReconcileSummary report={report} />
            <DifferenceList report={report} migration={migration} projectRef={projectRef} />
          </div>
        )}
      </section>

      <section className="mt-6 max-w-[760px]">
        <h3 className="type-small font-medium text-text">{t("jiraMigration.finish.checklistHeading")}</h3>
        <ul className="mt-2 flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 type-small text-text-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={checked.includes(item.id)} onChange={() => toggle(item.id)} />
                <span className={cn(checked.includes(item.id) && "text-text-3 line-through")}>{item.label}</span>
              </label>
              {item.link && (
                <a className="text-accent-text hover:underline" href={item.link.href} {...(item.link.external ? { target: "_blank", rel: "noreferrer" } : {})}>
                  {item.link.text}
                </a>
              )}
              {item.id === "filesLeft" && filesLeft > 0 && <LeftInJiraButton projectId={migration.projectId} jiraProjectKey={migration.jiraProjectKey} />}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
