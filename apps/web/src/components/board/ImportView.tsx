import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Badge, type BadgeTone } from "@kompast/ui/Badge";
import { FormField, TextField } from "@kompast/ui/Input";
import { EmptyState, SkeletonRows } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import { listImportRunsFn, startJiraImportFn } from "@/lib/server-fns/imports";
import { useIntlLocale } from "./project-shared";

type ImportRun = Awaited<ReturnType<typeof listImportRunsFn>>[number];

const STATUS_TONE: Record<string, BadgeTone> = { pending: "neutral", running: "accent", completed: "green", failed: "danger" };

function countOf(counts: unknown, key: string): number | null {
  if (!counts || typeof counts !== "object") return null;
  const v = (counts as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

/**
 * Runs synchronously against a real JIRA instance from this one request —
 * see startJiraImportFn's own doc comment for why. The API token is only
 * ever held in this component's state for one submit (cleared right after)
 * and never persisted.
 */
export function ImportView({ projectId, boardId }: { projectId: string; boardId: string }) {
  const { t } = useTranslation("board");
  const locale = useIntlLocale();
  const STATUS_LABEL: Record<string, string> = {
    pending: t("importTab.statusPending"),
    running: t("importTab.statusRunning"),
    completed: t("importTab.statusCompleted"),
    failed: t("importTab.statusFailed"),
  };
  const [runs, setRuns] = useState<ImportRun[] | null>(null);
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraApiToken, setJiraApiToken] = useState("");
  const [jql, setJql] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [fetchAttachments, setFetchAttachments] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [lastResult, setLastResult] = useState<Awaited<ReturnType<typeof startJiraImportFn>> | null>(null);

  async function refresh() {
    setRuns(await listImportRunsFn({ data: projectId }));
  }

  useEffect(() => {
    refresh().catch(() => setRuns([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const missing = !jiraBaseUrl.trim() || !jiraEmail.trim() || !jiraApiToken.trim() || !jql.trim();

  async function runImport() {
    setTouched(true);
    if (missing) return;
    setRunning(true);
    setLastResult(null);
    setRunError(null);
    try {
      const result = await startJiraImportFn({
        data: { projectId, boardId, jiraBaseUrl: jiraBaseUrl.trim(), jiraEmail: jiraEmail.trim(), jiraApiToken, jql: jql.trim(), dryRun, fetchAttachments },
      });
      setLastResult(result);
      setJiraApiToken("");
      await refresh();
    } catch (err) {
      setRunError(err instanceof Error ? err.message : t("genericError"));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 px-4 pb-12 pt-5 sm:px-6 xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]">
      <section className="rounded-[10px] border border-border bg-surface p-5">
        <h2 className="type-headline">{t("importTab.heading")}</h2>
        <p className="mb-4 mt-1 type-small text-text-2">{t("importTab.subtitle")}</p>
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            runImport();
          }}
        >
          <FormField label={t("importTab.baseUrlLabel")} htmlFor="jira-url" required>
            <TextField id="jira-url" type="url" value={jiraBaseUrl} onChange={(e) => setJiraBaseUrl(e.target.value)} placeholder={t("importTab.baseUrlPlaceholder")} aria-invalid={touched && !jiraBaseUrl.trim()} />
          </FormField>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <FormField label={t("importTab.emailLabel")} htmlFor="jira-email" required>
              <TextField id="jira-email" type="email" autoComplete="off" value={jiraEmail} onChange={(e) => setJiraEmail(e.target.value)} aria-invalid={touched && !jiraEmail.trim()} />
            </FormField>
            <FormField label={t("importTab.apiTokenLabel")} htmlFor="jira-token" hint={t("importTab.tokenHint")} required>
              <TextField id="jira-token" type="password" autoComplete="off" value={jiraApiToken} onChange={(e) => setJiraApiToken(e.target.value)} aria-invalid={touched && !jiraApiToken.trim()} />
            </FormField>
          </div>
          <FormField label={t("importTab.jqlLabel")} htmlFor="jira-jql" required>
            <TextField id="jira-jql" value={jql} onChange={(e) => setJql(e.target.value)} placeholder='project = "DEMO"' className="font-mono text-[13px]" aria-invalid={touched && !jql.trim()} />
          </FormField>
          <label className="flex items-start gap-2.5 text-[13.5px] text-text">
            <input type="checkbox" className="mt-0.5" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            <span>
              {t("importTab.dryRunLabel")}
              <span className="block type-small text-text-3">{t("importTab.dryRunHint")}</span>
            </span>
          </label>
          <label className="flex items-center gap-2.5 text-[13.5px] text-text">
            <input type="checkbox" checked={fetchAttachments} onChange={(e) => setFetchAttachments(e.target.checked)} />
            {t("importTab.fetchAttachmentsLabel")}
          </label>
          {touched && missing && <p className="type-small text-danger">{t("importTab.requiredHint")}</p>}
          <div>
            <Button type="submit" variant="primary" disabled={running}>
              <Download size={15} />
              {running ? t("importTab.importingEllipsis") : t("importTab.runButton")}
            </Button>
          </div>
          {runError && <p className="rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{runError}</p>}
          {lastResult?.error && <p className="rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{lastResult.error}</p>}
          {lastResult?.report && (
            <div className="rounded-[8px] border border-border bg-surface-2 p-3 type-small text-text-2">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                {[
                  [t("importTab.resultCreated"), lastResult.report.counts.issuesCreated],
                  [t("importTab.resultSkipped"), lastResult.report.counts.issuesSkipped],
                  [t("importTab.resultNewStatuses"), lastResult.report.counts.statusesCreated],
                  [t("importTab.resultNewTypes"), lastResult.report.counts.typesCreated],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <dt className="text-text-3">{label}</dt>
                    <dd className="text-[16px] font-semibold tabular-nums text-text">{value}</dd>
                  </div>
                ))}
              </dl>
              {lastResult.report.errors.length > 0 && <p className="mt-2 text-danger">{t("importTab.resultErrorsNote", { count: lastResult.report.errors.length })}</p>}
            </div>
          )}
        </form>
      </section>

      <section className="min-w-0">
        <h2 className="mb-3 type-headline">{t("importTab.historyHeading")}</h2>
        {runs === null ? (
          <SkeletonRows rows={3} />
        ) : runs.length === 0 ? (
          <EmptyState icon={<Download size={18} />} title={t("importTab.noImportsYet")} description={t("importTab.subtitle")} />
        ) : (
          <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
            <table className="w-full min-w-[520px] text-left text-[13.5px]">
              <thead className="bg-surface-2 type-label-overline text-text-2">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">{t("importTab.colSource")}</th>
                  <th className="px-3 py-2.5 font-semibold">{t("importTab.colStatus")}</th>
                  <th className="px-3 py-2.5 font-semibold">{t("importTab.colMode")}</th>
                  <th className="px-3 py-2.5 font-semibold">{t("importTab.colResult")}</th>
                  <th className="px-3 py-2.5 font-semibold">{t("importTab.colStarted")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const created = countOf(run.counts, "issuesCreated");
                  const skipped = countOf(run.counts, "issuesSkipped");
                  const errors = Array.isArray(run.errors) ? run.errors.length : 0;
                  return (
                    <tr key={run.id} className="border-t border-border">
                      <td className="px-3 py-2.5 font-medium">{run.source.toUpperCase()}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={STATUS_TONE[run.status] ?? "neutral"}>{STATUS_LABEL[run.status] ?? run.status}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-text-2">{run.dryRun ? t("importTab.dryRunTag") : t("importTab.realTag")}</td>
                      <td className="px-3 py-2.5 tabular-nums text-text-2">
                        {created !== null || skipped !== null ? t("importTab.countsSummary", { created: created ?? 0, skipped: skipped ?? 0 }) : t("importTab.noCounts")}
                        {errors > 0 && <span className="ml-2 text-danger">{t("importTab.errorCount", { count: errors })}</span>}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-text-3">
                        {new Date(run.startedAt ?? run.createdAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
