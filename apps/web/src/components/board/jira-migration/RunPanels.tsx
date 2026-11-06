import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { useTranslation } from "@kompast/i18n";
import { useIntlLocale } from "../project-shared";
import type { getJiraMigrationFn } from "@/lib/server-fns/jira-migration";
import { cn } from "@/lib/cn";
import { CredentialsForm, type JiraMigrationRow } from "./ConnectStep";
import { CompletedView, FinishPanel, LeftInJiraButton, runModeOf, type ProjectRef } from "./FinishPanel";
import { StatCard, StepHeading } from "./shared";

export type LatestRun = Awaited<ReturnType<typeof getJiraMigrationFn>>["latestRun"];
export type RunHistory = Awaited<ReturnType<typeof getJiraMigrationFn>>["runs"];

/** Discovery's progress, or the load's, as the runner writes it into jira_migration.progress. */
function progressOf(migration: JiraMigrationRow): { done: number; total: number | null } {
  const p = (migration.progress ?? {}) as { done?: unknown; total?: unknown };
  return { done: typeof p.done === "number" ? p.done : 0, total: typeof p.total === "number" ? p.total : null };
}

/** The attachments phase's progress, as the runner writes it into jira_migration.progress. Null in the data phase. */
function attachmentProgressOf(migration: JiraMigrationRow): { done: number; total: number; bytesDone: number; bytesTotal: number; failed: number } | null {
  const p = (migration.progress ?? {}) as Record<string, unknown>;
  if (p.phase !== "attachments") return null;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return { done: num(p.done), total: num(p.total), bytesDone: num(p.bytesDone), bytesTotal: num(p.bytesTotal), failed: num(p.failed) };
}

const GIGABYTE = 1024 ** 3;

/** Whether the run left files behind in JIRA: not copied, or failed for good. */
function filesLeftIn(run: { counts: unknown } | null | undefined): boolean {
  return filesLeftCountOf(run) > 0;
}

/** How many files the run left in JIRA: not copied (over the limit), or failed for good. */
function filesLeftCountOf(run: { counts: unknown } | null | undefined): number {
  const counts = (run?.counts ?? {}) as Record<string, unknown>;
  const n = (key: string) => (typeof counts[key] === "number" ? (counts[key] as number) : 0);
  return n("attachmentsNotMigrated") + n("attachmentsFailed");
}

function Bar({ percent }: { percent: number | null }) {
  return (
    <div className="mt-2 h-2 w-full max-w-[560px] overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      {percent === null ? (
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      ) : (
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
      )}
    </div>
  );
}

/** Scanning (state discovering) and a failed scan (state failed, no run started yet). */
export function ScanPanel({
  migration,
  canManage,
  busy,
  onRetry,
  onTokenSaved,
}: {
  migration: JiraMigrationRow;
  canManage: boolean;
  busy: boolean;
  onRetry: () => void;
  onTokenSaved: () => Promise<void>;
}) {
  const { t } = useTranslation("board");
  const [changingToken, setChangingToken] = useState(false);

  if (migration.state === "failed") {
    return (
      <div>
        <StepHeading title={t("jiraMigration.scan.failedHeading")} />
        <p className="max-w-[620px] rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{migration.error ?? t("genericError")}</p>
        {canManage && (
          <div className="mt-4 flex flex-col gap-4">
            <div className="flex gap-2">
              <Button variant="primary" onClick={onRetry} disabled={busy}>
                {t("jiraMigration.scan.tryAgain")}
              </Button>
              <Button variant="outline" onClick={() => setChangingToken((v) => !v)}>
                {t("jiraMigration.scan.changeToken")}
              </Button>
            </div>
            {changingToken && (
              <CredentialsForm
                migration={migration}
                tokenOnly
                onSaved={async () => {
                  setChangingToken(false);
                  await onTokenSaved();
                }}
                onCancel={() => setChangingToken(false)}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  const { done } = progressOf(migration);
  return (
    <div>
      <StepHeading
        title={t("jiraMigration.scan.heading")}
        description={done > 0 ? t("jiraMigration.scan.progress", { key: migration.jiraProjectKey, done }) : t("jiraMigration.scan.starting")}
      />
      <Bar percent={null} />
      <p className="mt-3 type-small text-text-3">{t("jiraMigration.scan.background")}</p>
    </div>
  );
}

/** The counts a sync changed, summed into the "n changes" a line in the run panel shows. */
const SYNC_CHANGE_KEYS = [
  "issuesCreated",
  "issuesUpdated",
  "commentsAdded",
  "commentsUpdated",
  "worklogsAdded",
  "worklogsUpdated",
  "historyEntriesRecorded",
  "linksCreated",
  "watchersAdded",
  "attachmentsQueued",
  "sprintsCreated",
  "sprintsStarted",
  "sprintsCompleted",
] as const;

/** A count from a run's counts or notes-free JSON, as a number (0 when absent). */
function countOf(counts: unknown, key: string): number {
  const v = (counts as Record<string, unknown> | null)?.[key];
  return typeof v === "number" ? v : 0;
}

function changesOf(counts: unknown): number {
  return SYNC_CHANGE_KEYS.reduce((sum, key) => sum + countOf(counts, key), 0);
}

/** A run's mode: "sync" for a catch-up, "reconcile" for a completeness check, else a full import. */
const modeOf = runModeOf;

/** "3 hours ago", "in 2 minutes", "just now": relative to now, in the viewer's locale. */
function relativeTime(value: Date | string | null | undefined, locale: string): string {
  if (!value) return "";
  const diffMs = new Date(value).getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diffMs);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) if (abs >= ms) return rtf.format(Math.round(diffMs / ms), unit);
  return rtf.format(0, "minute");
}

/** The notes of a sync run: what it found but didn't change on its own, as lines of text. */
type SyncNotesShape = {
  newStatuses: string[];
  newTypes: string[];
  newProperties: string[];
  newPeople: string[];
  conflicts: { issueKey: string; fields: string[] }[];
  commentsMissingInJira: { issueKey: string; count: number }[];
  worklogsMissingInJira: { issueKey: string; count: number }[];
  linksMissingInJira: { issueKey: string; count: number }[];
  attachmentsMissingInJira: { issueKey: string; count: number }[];
  deletedInJira: string[];
  movedInJira: { key: string; newKey: string }[];
};

/** The sync's notes, collapsed by default. Each list shows only when it has entries. */
function SyncNotes({ notes }: { notes: SyncNotesShape | null }) {
  const { t } = useTranslation("board");
  if (!notes) return null;
  const join = (items: string[]) => items.join(", ");
  const missing = [...notes.commentsMissingInJira, ...notes.worklogsMissingInJira, ...notes.linksMissingInJira, ...notes.attachmentsMissingInJira];
  const lines: string[] = [];
  if (notes.newStatuses.length) lines.push(t("jiraMigration.run.notesNewStatuses", { list: join(notes.newStatuses) }));
  if (notes.newTypes.length) lines.push(t("jiraMigration.run.notesNewTypes", { list: join(notes.newTypes) }));
  if (notes.newProperties.length) lines.push(t("jiraMigration.run.notesNewProperties", { list: join(notes.newProperties) }));
  if (notes.newPeople.length) lines.push(t("jiraMigration.run.notesNewPeople", { list: join(notes.newPeople) }));
  if (notes.conflicts.length) {
    lines.push(t("jiraMigration.run.notesConflicts", { list: join(notes.conflicts.map((c) => `${c.issueKey} (${c.fields.join(", ")})`)) }));
  }
  if (notes.deletedInJira.length) lines.push(t("jiraMigration.run.notesDeleted", { list: join(notes.deletedInJira) }));
  if (notes.movedInJira.length) {
    lines.push(t("jiraMigration.run.notesMoved", { list: join(notes.movedInJira.map((m) => t("jiraMigration.run.notesMovedEach", { key: m.key, newKey: m.newKey }))) }));
  }
  if (missing.length) {
    lines.push(
      t("jiraMigration.run.notesMissing", {
        list: join(missing.map((m) => t("jiraMigration.run.notesMissingEach", { issue: m.issueKey, count: m.count }))),
      }),
    );
  }
  return (
    <details className="mt-4 max-w-[760px] rounded-[6px] border border-border px-3 py-2">
      <summary className="cursor-pointer type-small text-text-2">{t("jiraMigration.run.notesToggle")}</summary>
      {lines.length === 0 ? (
        <p className="mt-2 type-small text-text-3">{t("jiraMigration.run.notesNone")}</p>
      ) : (
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 type-small text-text-2">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** Running, synced, a failed run, or completed. Actions only show for project admins. */
export function RunPanel({
  migration,
  runs,
  projectRef,
  canManage,
  busy,
  onSync,
  onReimport,
  onAutoSync,
  onRescan,
  onCheck,
  onCheckBeforeFinish,
  onFinish,
  onRetry,
  onStartOver,
}: {
  migration: JiraMigrationRow;
  runs: RunHistory;
  projectRef: ProjectRef | null;
  canManage: boolean;
  busy: boolean;
  onSync: () => void;
  onReimport: () => void;
  onAutoSync: (minutes: 15 | 60 | 240 | null) => void;
  onRescan: () => void;
  /** A completeness check: reads both sides, changes nothing. */
  onCheck: () => void;
  /** A sync, then a completeness check, for finishing. */
  onCheckBeforeFinish: () => void;
  /** Finishes the migration. `acknowledgedDifferences` is the user's "I've reviewed the differences" tick. */
  onFinish: (acknowledgedDifferences: boolean) => void;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  const { t } = useTranslation("board");
  const locale = useIntlLocale();
  const [confirm, setConfirm] = useState<"startOver" | "reimport" | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const { done, total } = progressOf(migration);
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : null;
  const date = (value: Date | string | null | undefined) => (value ? new Date(value).toLocaleDateString(locale, { dateStyle: "medium" }) : "");

  if (migration.state === "running") {
    const copying = attachmentProgressOf(migration);
    if (copying) {
      const copyPercent = copying.total ? Math.min(100, Math.round((copying.done / copying.total) * 100)) : null;
      return (
        <div>
          <StepHeading title={t("jiraMigration.run.copyingAttachmentsHeading")} description={t("jiraMigration.run.boardUsable")} />
          <p className="type-small text-text-2">
            {t("jiraMigration.run.copyingAttachments", {
              done: copying.done,
              total: copying.total,
              doneGb: (copying.bytesDone / GIGABYTE).toFixed(2),
              totalGb: (copying.bytesTotal / GIGABYTE).toFixed(2),
            })}
          </p>
          {copying.failed > 0 && <p className="type-small text-danger">{t("jiraMigration.run.copyingAttachmentsFailed", { count: copying.failed })}</p>}
          <Bar percent={copyPercent} />
        </div>
      );
    }
    const phase = (migration.progress as { phase?: unknown } | null)?.phase;
    if (phase === "reconcile") {
      return (
        <div>
          <StepHeading title={t("jiraMigration.run.checkingHeading")} description={t("jiraMigration.run.background")} />
          <p className="type-small text-text-2">{t("jiraMigration.run.checkingLine", { done })}</p>
        </div>
      );
    }
    const syncing = phase === "sync";
    return (
      <div>
        <StepHeading title={t("jiraMigration.run.runningHeading")} description={t("jiraMigration.run.background")} />
        {syncing ? (
          <p className="type-small text-text-2">{t("jiraMigration.run.progressUnknown")}</p>
        ) : (
          <>
            <p className="type-small text-text-2">{total ? t("jiraMigration.run.progressLabel", { done, total, percent: percent ?? 0 }) : t("jiraMigration.run.progressUnknown")}</p>
            <Bar percent={percent} />
          </>
        )}
      </div>
    );
  }

  if (migration.state === "failed") {
    return (
      <div>
        <StepHeading title={t("jiraMigration.run.failedHeading")} />
        <p className="max-w-[620px] rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{migration.error ?? t("genericError")}</p>
        {canManage && (
          <div className="mt-4">
            <Button variant="primary" onClick={onRetry} disabled={busy}>
              {t("jiraMigration.run.retry")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  // The newest run that changed data (a completeness check changes none, so it doesn't drive the cards).
  const dataRun = runs.find((r) => modeOf(r) !== "reconcile") ?? null;
  const dataRunErrors = dataRun && Array.isArray(dataRun.errors) ? dataRun.errors.length : 0;

  if (migration.state === "completed") {
    const formerCount = ((migration.mapping as { people?: { action?: unknown }[] } | null)?.people ?? []).filter((p) => p.action === "former").length;
    return (
      <div>
        <CompletedView migration={migration} projectRef={projectRef} filesLeft={filesLeftCountOf(dataRun)} formerCount={formerCount} />
        {canManage && (
          <div className="mt-4">
            <Button variant="outline" onClick={() => setConfirm("startOver")} disabled={busy}>
              {t("jiraMigration.run.startOver")}
            </Button>
          </div>
        )}
        <StartOverDialog open={confirm === "startOver"} onClose={() => setConfirm(null)} onConfirm={() => { setConfirm(null); onStartOver(); }} busy={busy} />
      </div>
    );
  }

  // synced. The newest data run shows its own counts; the last sync's changes and notes show in the line and the notes.
  const latestSync = runs.find((r) => modeOf(r) === "sync") ?? null;
  const latestIsSync = !!dataRun && modeOf(dataRun) === "sync";
  const latestCheck = runs.find((r) => modeOf(r) === "reconcile" && r.status === "completed") ?? null;
  const latestCheckUnexplained = latestCheck
    ? Object.values((latestCheck.counts ?? {}) as Record<string, { unexplained?: unknown }>).reduce((sum, c) => sum + (typeof c?.unexplained === "number" ? c.unexplained : 0), 0)
    : 0;
  const shownCounts = (dataRun?.counts ?? {}) as Record<string, unknown>;
  const n = (key: string) => countOf(shownCounts, key);
  const fullCards: [string, number][] = [
    [t("jiraMigration.run.resultIssues"), n("issuesCreated")],
    [t("jiraMigration.run.resultSkipped"), n("issuesSkipped")],
    [t("jiraMigration.run.resultComments"), n("commentsCreated")],
    [t("jiraMigration.run.resultWorklogs"), n("worklogsCreated")],
    [t("jiraMigration.run.resultLinks"), n("linksCreated")],
    [t("jiraMigration.run.resultStatuses"), n("statusesCreated")],
    [t("jiraMigration.run.resultTypes"), n("typesCreated")],
    [t("jiraMigration.run.resultSprints"), n("sprintsCreated")],
    [t("jiraMigration.run.resultProperties"), n("propertiesCreated")],
    [t("jiraMigration.run.resultFieldValues"), n("fieldValuesWritten")],
    [t("jiraMigration.run.resultFieldSkipped"), n("fieldValuesSkipped")],
    [t("jiraMigration.run.resultRenumbered"), n("issuesRenumbered")],
    [t("jiraMigration.run.resultFormerMembers"), n("formerMembersCreated")],
    [t("jiraMigration.run.resultHistory"), n("historyEntriesRecorded")],
    [t("jiraMigration.run.resultWatchers"), n("watchersAdded")],
    [t("jiraMigration.run.resultMentions"), n("issueMentionsResolved")],
    [t("jiraMigration.run.resultInlineMediaUnmatched"), n("inlineMediaUnmatched")],
    [t("jiraMigration.run.resultAttachmentsStored"), n("attachmentsStored")],
    [t("jiraMigration.run.resultAttachmentsNotMigrated"), n("attachmentsNotMigrated")],
    [t("jiraMigration.run.resultAttachmentsFailed"), n("attachmentsFailed")],
  ];
  const syncCards: [string, number][] = [
    [t("jiraMigration.run.syncIssuesCreated"), n("issuesCreated")],
    [t("jiraMigration.run.syncIssuesUpdated"), n("issuesUpdated")],
    [t("jiraMigration.run.syncIssuesUnchanged"), n("issuesUnchanged")],
    [t("jiraMigration.run.syncComments"), n("commentsAdded")],
    [t("jiraMigration.run.syncCommentsUpdated"), n("commentsUpdated")],
    [t("jiraMigration.run.syncWorklogs"), n("worklogsAdded")],
    [t("jiraMigration.run.syncWorklogsUpdated"), n("worklogsUpdated")],
    [t("jiraMigration.run.syncHistory"), n("historyEntriesRecorded")],
    [t("jiraMigration.run.syncLinks"), n("linksCreated")],
    [t("jiraMigration.run.syncWatchers"), n("watchersAdded")],
    [t("jiraMigration.run.syncFilesQueued"), n("attachmentsQueued")],
    [t("jiraMigration.run.syncSprintsCreated"), n("sprintsCreated")],
    [t("jiraMigration.run.syncSprintsStarted"), n("sprintsStarted")],
    [t("jiraMigration.run.syncSprintsCompleted"), n("sprintsCompleted")],
  ];
  const cards = latestIsSync ? syncCards : fullCards;
  const lastSyncChanges = latestSync ? changesOf(latestSync.counts) : 0;
  const filesLeft = filesLeftIn(dataRun);
  const syncNotes = (latestSync?.notes && !Array.isArray(latestSync.notes) ? latestSync.notes : null) as SyncNotesShape | null;
  const runCountOf = (run: (typeof runs)[number]) => ({ issues: countOf(run.counts, "issuesCreated") + countOf(run.counts, "issuesUpdated"), changes: changesOf(run.counts) });

  return (
    <div>
      <StepHeading
        title={t("jiraMigration.run.syncedHeading")}
        description={
          migration.lastSyncedAt
            ? t("jiraMigration.run.lastSynced", { when: relativeTime(migration.lastSyncedAt, locale), changes: lastSyncChanges })
            : t("jiraMigration.run.lastSyncedNever")
        }
      />
      <p className="mt-1 type-small text-text-3">{t("jiraMigration.run.syncedLine", { date: date(migration.lastSyncedAt) })}</p>
      <dl className="mt-3 grid max-w-[760px] grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map(([label, value]) => (
          <StatCard key={label} label={label}>
            <span className="tabular-nums">{value}</span>
          </StatCard>
        ))}
      </dl>
      {dataRunErrors > 0 && <p className="mt-3 type-small text-danger">{t("jiraMigration.run.errorsLine", { count: dataRunErrors })}</p>}
      {latestCheck && (
        <p className={cn("mt-3 type-small", latestCheckUnexplained === 0 ? "text-text-2" : "text-danger")}>
          {latestCheckUnexplained === 0
            ? t("jiraMigration.run.lastCheckClean")
            : t("jiraMigration.run.lastCheckDiffs", { count: latestCheckUnexplained })}
        </p>
      )}
      {filesLeft && (
        <div className="mt-3">
          <LeftInJiraButton projectId={migration.projectId} jiraProjectKey={migration.jiraProjectKey} />
        </div>
      )}
      {latestSync && <SyncNotes notes={syncNotes} />}

      <p className="mt-4 max-w-[760px] type-small text-text-3">{t("jiraMigration.run.readOnlyNote")}</p>

      {canManage && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={onSync} disabled={busy}>
            {t("jiraMigration.run.syncNow")}
          </Button>
          <Button variant="outline" onClick={onRescan} disabled={busy}>
            {t("jiraMigration.run.rescan")}
          </Button>
          <Button variant="outline" onClick={onCheck} disabled={busy}>
            {t("jiraMigration.run.checkCompleteness")}
          </Button>
          <Button variant="outline" onClick={() => setFinishOpen((v) => !v)} disabled={busy}>
            {t("jiraMigration.run.finish")}
          </Button>
          <button type="button" onClick={() => setConfirm("reimport")} disabled={busy} className="type-small text-text-2 hover:underline disabled:opacity-60">
            {t("jiraMigration.run.reimportAll")}
          </button>
          <label className="ml-auto flex items-center gap-2 type-small text-text-2">
            {t("jiraMigration.run.autoSyncLabel")}
            <select
              className="rounded-[6px] border border-border bg-surface px-2 py-1 type-small text-text"
              value={migration.autoSyncMinutes === null || migration.autoSyncMinutes === undefined ? "off" : String(migration.autoSyncMinutes)}
              disabled={busy}
              onChange={(e) => onAutoSync(e.target.value === "off" ? null : (Number(e.target.value) as 15 | 60 | 240))}
            >
              <option value="off">{t("jiraMigration.run.autoSyncOff")}</option>
              <option value="15">{t("jiraMigration.run.autoSyncEvery15")}</option>
              <option value="60">{t("jiraMigration.run.autoSyncHourly")}</option>
              <option value="240">{t("jiraMigration.run.autoSyncEvery4h")}</option>
            </select>
          </label>
        </div>
      )}

      {runs.length > 0 && (
        <section className="mt-6 max-w-[760px]">
          <h3 className="type-small font-medium text-text">{t("jiraMigration.run.historyHeading")}</h3>
          <ul className="mt-2 flex flex-col gap-1 type-small text-text-2">
            {runs.map((run) => {
              const c = runCountOf(run);
              return (
                <li key={run.id} className="tabular-nums">
                  {t("jiraMigration.run.historyRow", {
                    mode: t(modeOf(run) === "sync" ? "jiraMigration.run.historySync" : modeOf(run) === "reconcile" ? "jiraMigration.run.historyReconcile" : "jiraMigration.run.historyFull"),
                    when: relativeTime(run.createdAt, locale),
                    status: run.status,
                  })}
                  {" · "}
                  {t("jiraMigration.run.historyCounts", { issues: c.issues, changes: c.changes })}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Dialog
        open={confirm === "reimport"}
        onClose={() => setConfirm(null)}
        title={t("jiraMigration.run.reimportConfirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
                onReimport();
              }}
            >
              {t("jiraMigration.run.confirmReimport")}
            </Button>
          </>
        }
      >
        <p className="type-small text-text-2">{t("jiraMigration.run.reimportConfirmBody")}</p>
      </Dialog>

      {finishOpen && canManage && (
        <FinishPanel
          migration={migration}
          runs={runs}
          projectRef={projectRef}
          canManage={canManage}
          busy={busy}
          onCheckBeforeFinish={onCheckBeforeFinish}
          onFinish={(acknowledged) => {
            setFinishOpen(false);
            onFinish(acknowledged);
          }}
          onClose={() => setFinishOpen(false)}
        />
      )}
    </div>
  );
}

function StartOverDialog({ open, onClose, onConfirm, busy }: { open: boolean; onClose: () => void; onConfirm: () => void; busy: boolean }) {
  const { t } = useTranslation("board");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("jiraMigration.run.startOverConfirmTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            {t("jiraMigration.run.confirmStartOver")}
          </Button>
        </>
      }
    >
      <p className="type-small text-text-2">{t("jiraMigration.run.startOverConfirmBody")}</p>
    </Dialog>
  );
}
