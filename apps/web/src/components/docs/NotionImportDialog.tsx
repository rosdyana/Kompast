import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { FileArchive, Lock, Users, UsersRound } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";
import { listTeamsFn } from "@/lib/server-fns/teams";

export type NotionImportTarget = "workspace" | "private";

/** The dialog's choices: the two docs spaces, or a team's space (which also needs a team picked). */
type ImportDestination = NotionImportTarget | "team";

interface TeamOption {
  id: string;
  name: string;
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

interface ImportReport {
  counts: { pagesCreated: number; pagesSkipped: number; assetsUploaded: number };
  rootPageIds: string[];
  errors: { page: string; error: string }[];
}

/**
 * Uploads a Notion export zip to POST /api/v1/imports/notion with the
 * session cookie (a server function doesn't carry a file upload well).
 * Workspace is offered only to workspace admins; the server checks that
 * again (requirePageImportTarget), this just hides a choice that would fail.
 * Team lists every team the caller may import into: the teams they belong
 * to (every team for the super admin), matching the page RLS policy.
 *
 * Opens on a chooser: connect to Notion through the API wizard (`onConnect`),
 * or upload an export zip (the form below).
 */
export function NotionImportDialog({
  open,
  onClose,
  initialTarget,
  canImportToWorkspace,
  onConnect,
}: {
  open: boolean;
  onClose: () => void;
  initialTarget: NotionImportTarget;
  canImportToWorkspace: boolean;
  onConnect: () => void;
}) {
  const { t } = useTranslation("docs");
  const router = useRouter();
  const [mode, setMode] = useState<"choose" | "zip">("choose");
  const [target, setTarget] = useState<ImportDestination>(initialTarget);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [teamId, setTeamId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode("choose");
    setTarget(canImportToWorkspace ? initialTarget : "private");
    setTeamId("");
    setFile(null);
    setError(null);
    setReport(null);
    let cancelled = false;
    listTeamsFn().then(
      (all) => {
        if (!cancelled) setTeams(all.filter((team) => !team.locked).map((team) => ({ id: team.id, name: team.name })));
      },
      () => {
        if (!cancelled) setTeams([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, initialTarget, canImportToWorkspace]);

  async function runImport() {
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t("notionImport.tooLarge"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("target", target);
      if (target === "team") form.set("teamId", teamId);
      const res = await fetch("/api/v1/imports/notion", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.report) throw new Error(body.error ?? body.detail ?? res.statusText);
      setReport(body.report);
      await router.invalidate();
    } catch (err) {
      setError(t("notionImport.failed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function openImported() {
    const pageId = report?.rootPageIds[0];
    onClose();
    if (pageId) await router.navigate({ to: "/docs/$pageId", params: { pageId } });
  }

  const choices: { value: ImportDestination; label: string; hint: string; icon: ReactNode }[] = [
    ...(canImportToWorkspace
      ? [{ value: "workspace" as const, label: t("notionImport.workspace"), hint: t("notionImport.workspaceHint"), icon: <Users size={15} strokeWidth={1.75} /> }]
      : []),
    ...(teams.length > 0
      ? [{ value: "team" as const, label: t("notionImport.team"), hint: t("notionImport.teamHint"), icon: <UsersRound size={15} strokeWidth={1.75} /> }]
      : []),
    { value: "private", label: t("notionImport.private"), hint: t("notionImport.privateHint"), icon: <Lock size={15} strokeWidth={1.75} /> },
  ];

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      size="md"
      title={t("notionImport.title")}
      closeLabel={t("common:close")}
      footer={
        mode === "choose" ? (
          <Button variant="ghost" onClick={onClose}>
            {t("common:cancel")}
          </Button>
        ) : report ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("common:close")}
            </Button>
            {report.rootPageIds.length > 0 && (
              <Button variant="primary" onClick={openImported} data-autofocus>
                {t("notionImport.open")}
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setMode("choose")} disabled={busy}>
              {t("notionMigration.back")}
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t("common:cancel")}
            </Button>
            <Button variant="primary" onClick={runImport} disabled={!file || busy || (target === "team" && !teamId)}>
              {t("notionImport.import")}
            </Button>
          </>
        )
      }
    >
      {mode === "choose" ? (
        <div className="flex flex-col gap-3">
          <p className="type-body text-text-2">{t("notionMigration.chooserHeading")}</p>
          <button
            type="button"
            onClick={onConnect}
            className="flex flex-col items-start gap-1 rounded-[8px] border border-accent bg-accent-soft px-4 py-3 text-left hover:opacity-90"
          >
            <span className="flex items-center gap-2 text-[14px] font-medium text-text">
              {t("notionMigration.chooseConnect")}
              <span className="rounded-full bg-surface px-2 py-0.5 text-[11.5px] font-medium text-accent-text">{t("notionMigration.chooseConnectTag")}</span>
            </span>
            <span className="text-[13px] text-text-2">{t("notionMigration.chooseConnectHint")}</span>
          </button>
          <button
            type="button"
            onClick={() => setMode("zip")}
            className="flex flex-col items-start gap-1 rounded-[8px] border border-border px-4 py-3 text-left hover:bg-surface-2"
          >
            <span className="flex items-center gap-2 text-[14px] font-medium text-text">
              <FileArchive size={15} strokeWidth={1.75} className="text-text-3" />
              {t("notionMigration.chooseZip")}
            </span>
            <span className="text-[13px] text-text-3">{t("notionMigration.chooseZipHint")}</span>
          </button>
        </div>
      ) : report ? (
        <div className="flex flex-col gap-1.5 text-[14px] text-text-2">
          <p>{t("notionImport.created", { count: report.counts.pagesCreated })}</p>
          {report.counts.pagesSkipped > 0 && <p>{t("notionImport.skipped", { count: report.counts.pagesSkipped })}</p>}
          {report.counts.assetsUploaded > 0 && <p>{t("notionImport.assets", { count: report.counts.assetsUploaded })}</p>}
          {report.errors.length > 0 && (
            <div className="mt-2 rounded-[6px] bg-surface-2 px-3 py-2 text-[13px]">
              <p className="font-medium text-text">{t("notionImport.problems")}</p>
              <ul className="mt-1 max-h-40 list-disc overflow-auto pl-5">
                {report.errors.map((e) => (
                  <li key={`${e.page}:${e.error}`}>
                    <span className="text-text">{e.page}</span>: {e.error}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="type-body text-text-2">{t("notionImport.intro")}</p>

          <fieldset className="flex flex-col gap-1.5" disabled={busy}>
            <legend className="mb-1.5 text-[13px] font-medium text-text-2">{t("notionImport.destination")}</legend>
            {choices.map((choice) => (
              <label
                key={choice.value}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-[6px] border px-3 py-2",
                  target === choice.value ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
                )}
              >
                <input type="radio" name="notion-import-target" className="sr-only" checked={target === choice.value} onChange={() => setTarget(choice.value)} />
                <span className="mt-0.5 text-text-3">{choice.icon}</span>
                <span className="flex flex-col">
                  <span className="text-[14px] font-medium text-text">{choice.label}</span>
                  <span className="text-[13px] text-text-3">{choice.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {target === "team" && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-text-2">{t("notionImport.teamLabel")}</span>
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={busy} className="kp-field kp-select h-8">
                <option value="">{t("notionImport.teamPlaceholder")}</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-text-2">{t("notionImport.file")}</span>
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-[13px] text-text-2 file:mr-3 file:rounded-[6px] file:border file:border-border-2 file:bg-surface file:px-2.5 file:py-1 file:text-[13px] file:text-text hover:file:bg-surface-2"
            />
          </label>

          {busy && <p className="text-[13px] text-text-3">{t("notionImport.importing")}</p>}
          {error && <p className="rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
