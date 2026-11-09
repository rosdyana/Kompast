import { useEffect, useState } from "react";
import { Button } from "@kompast/ui/Button";
import { Spinner } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import { getNotionImportReportFn, rediscoverNotionFn, retryNotionMigrationFn, updateNotionTokenFn, type NotionImportReport } from "@/lib/server-fns/notion-migration";
import { TokenField, type MigrationView } from "./shared";

interface RunStepProps {
  migration: MigrationView;
  busy: boolean;
  /** Runs a server action with the wizard's busy and error handling, then re-reads the migration. */
  onAct: (run: () => Promise<unknown>) => void;
  /** Opens the first imported root page, or the docs home when there isn't one yet. */
  onOpen: (pageId: string | null) => void;
}

/** The runner's progress as it writes it into notion_migration.progress. */
interface Progress {
  phase?: string;
  created?: number;
  skipped?: number;
  contentDone?: number;
  contentTotal?: number;
  assetsUploaded?: number;
  unknownBlocks?: number;
  errors?: number;
}

const PHASES = ["plan", "create", "users", "content"] as const;

/**
 * Step 5: the run. Polls (the wizard does) while running, shows the report
 * when done, and offers Retry or a new token when it stopped.
 */
export function RunStep({ migration, busy, onAct, onOpen }: RunStepProps) {
  const { t } = useTranslation("docs");
  const state = migration.state;
  const [report, setReport] = useState<NotionImportReport | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);

  useEffect(() => {
    if (state !== "done" && state !== "failed") return;
    let cancelled = false;
    getNotionImportReportFn({ data: { id: migration.id } }).then(
      (next) => {
        if (!cancelled) setReport(next);
      },
      () => {
        if (!cancelled) setReport(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [migration.id, state]);

  if (state === "running") return <RunProgress migration={migration} />;

  if (state === "done") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <h3 className="type-headline">{t("notionMigration.run.done")}</h3>
        </div>
        {report ? <ReportBlock report={report} /> : <Spinner size={14} />}
        <div className="flex justify-end gap-2">
          {/* Re-scans Notion and goes back to the picker. Pages already imported are skipped on the next run. */}
          <Button variant="secondary" onClick={() => onAct(() => rediscoverNotionFn({ data: { id: migration.id } }))} disabled={busy || !migration.hasToken}>
            {t("notionMigration.run.importMore")}
          </Button>
          <Button variant="primary" onClick={() => onOpen(report?.rootPageIds[0] ?? null)} disabled={busy}>
            {report && report.rootPageIds.length > 0 ? t("notionMigration.run.open") : t("notionMigration.run.openDocs")}
          </Button>
        </div>
      </div>
    );
  }

  if (state === "failed") {
    const saveToken = () => {
      const value = token.trim();
      if (!value) {
        setTokenError(t("notionMigration.setup.required"));
        return;
      }
      setTokenError(null);
      setToken("");
      setTokenOpen(false);
      onAct(() => updateNotionTokenFn({ data: { id: migration.id, token: value } }));
    };
    return (
      <div className="flex flex-col gap-4">
        <h3 className="type-headline">{t("notionMigration.run.failedHeading")}</h3>
        <p className="rounded-[6px] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">{migration.error ?? t("notionMigration.genericError")}</p>
        <p className="type-small text-text-2">{t("notionMigration.run.failedHint")}</p>
        {report && <ReportBlock report={report} />}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => onAct(() => retryNotionMigrationFn({ data: { id: migration.id } }))} disabled={busy || !migration.hasToken}>
            {t("notionMigration.run.retry")}
          </Button>
          <Button variant="outline" onClick={() => setTokenOpen((open) => !open)} disabled={busy}>
            {t("notionMigration.run.updateToken")}
          </Button>
        </div>
        {tokenOpen && (
          <div className="flex max-w-[520px] flex-col gap-3">
            <p className="type-small text-text-2">{t("notionMigration.run.tokenHeading")}</p>
            <TokenField id="notion-token-update" label={t("notionMigration.setup.tokenLabel")} value={token} onChange={setToken} />
            {tokenError && <p className="type-small text-danger">{tokenError}</p>}
            <div>
              <Button variant="primary" onClick={saveToken} disabled={busy}>
                {t("notionMigration.setup.saveSecret")}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return null;
}

/** The progress panel while the worker runs the migration. */
function RunProgress({ migration }: { migration: MigrationView }) {
  const { t } = useTranslation("docs");
  const p = (migration.progress ?? {}) as unknown as Progress;
  const phase = (PHASES as readonly string[]).includes(p.phase ?? "") ? (p.phase as (typeof PHASES)[number]) : null;
  const total = p.contentTotal ?? 0;
  const done = p.contentDone ?? 0;
  const percent = phase === "content" && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <Spinner size={16} />
        <h3 className="type-headline">{t("notionMigration.run.running")}</h3>
      </div>
      <p className="type-small text-text-2">{phase ? t(`notionMigration.run.phase.${phase}`) : t("notionMigration.run.waiting")}</p>
      <div className="h-2 w-full max-w-[560px] overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        {percent === null ? (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
        ) : (
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
        )}
      </div>
      <ul className="flex flex-col gap-1 text-[13.5px] text-text-2">
        {p.created !== undefined && <li>{t("notionMigration.run.created", { count: p.created })}</li>}
        {p.skipped !== undefined && p.skipped > 0 && <li>{t("notionMigration.run.skipped", { count: p.skipped })}</li>}
        {phase === "content" && <li>{t("notionMigration.run.contentProgress", { done, total })}</li>}
        {p.assetsUploaded !== undefined && p.assetsUploaded > 0 && <li>{t("notionMigration.run.assets", { count: p.assetsUploaded })}</li>}
        {p.errors !== undefined && p.errors > 0 && <li className="text-danger">{t("notionMigration.run.errors", { count: p.errors })}</li>}
      </ul>
    </div>
  );
}

/** The counts and problem list of the newest import run. */
function ReportBlock({ report }: { report: NotionImportReport }) {
  const { t } = useTranslation("docs");
  const c = report.counts;
  const errorCount = c.errorCount ?? report.errors.length;
  return (
    <div className="flex flex-col gap-1.5 rounded-[8px] border border-border bg-surface-2 p-3.5 text-[13.5px] text-text-2">
      <p className="text-[13px] font-medium text-text">{t("notionMigration.run.reportHeading")}</p>
      <p>{t("notionMigration.run.created", { count: c.created ?? 0 })}</p>
      {(c.skipped ?? 0) > 0 && <p>{t("notionMigration.run.skipped", { count: c.skipped ?? 0 })}</p>}
      {(c.assetsUploaded ?? 0) > 0 && <p>{t("notionMigration.run.assets", { count: c.assetsUploaded ?? 0 })}</p>}
      {(c.filesNotImported ?? 0) > 0 && <p>{t("notionMigration.run.filesNotImported", { count: c.filesNotImported ?? 0 })}</p>}
      {(c.unknownBlocks ?? 0) > 0 && <p>{t("notionMigration.run.unknownBlocks", { count: c.unknownBlocks ?? 0 })}</p>}
      {errorCount > 0 && (
        <div className="mt-2">
          <p className="font-medium text-text">{t("notionMigration.run.problems")}</p>
          <ul className="mt-1 max-h-40 list-disc overflow-auto pl-5">
            {report.errors.map((e) => (
              <li key={`${e.page}:${e.error}`}>
                <span className="text-text">{e.page}</span>: {e.error}
              </li>
            ))}
          </ul>
          {errorCount > report.errors.length && <p className="mt-1">{t("notionMigration.run.moreProblems", { count: errorCount - report.errors.length })}</p>}
        </div>
      )}
    </div>
  );
}
