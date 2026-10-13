import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { Lock, Users } from "lucide-react";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { useTranslation } from "@kompast/i18n";
import { cn } from "@/lib/cn";

export type NotionImportTarget = "workspace" | "private";

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
 */
export function NotionImportDialog({
  open,
  onClose,
  initialTarget,
  canImportToWorkspace,
}: {
  open: boolean;
  onClose: () => void;
  initialTarget: NotionImportTarget;
  canImportToWorkspace: boolean;
}) {
  const { t } = useTranslation("docs");
  const router = useRouter();
  const [target, setTarget] = useState<NotionImportTarget>(initialTarget);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  useEffect(() => {
    if (!open) return;
    setTarget(canImportToWorkspace ? initialTarget : "private");
    setFile(null);
    setError(null);
    setReport(null);
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

  const choices: { value: NotionImportTarget; label: string; hint: string; icon: ReactNode }[] = [
    ...(canImportToWorkspace
      ? [{ value: "workspace" as const, label: t("notionImport.workspace"), hint: t("notionImport.workspaceHint"), icon: <Users size={15} strokeWidth={1.75} /> }]
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
        report ? (
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
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              {t("common:cancel")}
            </Button>
            <Button variant="primary" onClick={runImport} disabled={!file || busy}>
              {t("notionImport.import")}
            </Button>
          </>
        )
      }
    >
      {report ? (
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
