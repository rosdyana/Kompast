import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { SkeletonRows, Spinner } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import { useIntlLocale } from "@/components/board/project-shared";
import {
  buildNotionTree,
  countSelection,
  selectionFromSaved,
  selectionRoots,
  type NotionTargetChoice,
  type RootSelection,
} from "@/lib/notion-migration-tree";
import { listTeamsFn } from "@/lib/server-fns/teams";
import {
  checkNotionTokenFn,
  createNotionMigrationFn,
  deleteNotionMigrationFn,
  getNotionMigrationFn,
  listNotionMigrationsFn,
  rediscoverNotionFn,
  saveNotionSelectionFn,
  startNotionMigrationFn,
} from "@/lib/server-fns/notion-migration";
import { PickStep } from "./PickStep";
import { ReviewStep } from "./ReviewStep";
import { RunStep } from "./RunStep";
import { errorText, NOTION_INTEGRATIONS_URL, StateBadge, TokenField, type DiscoveryView, type MigrationView, type SavedSelection, type TeamOption } from "./shared";

type ListRow = Awaited<ReturnType<typeof listNotionMigrationsFn>>[number];

export interface NotionMigrationWizardProps {
  open: boolean;
  onClose: () => void;
  /** The destination the sidebar action started from. Used as the default for each checked page, when Workspace is allowed. */
  initialTarget: "workspace" | "private";
  canImportToWorkspace: boolean;
}

/** How often the wizard re-reads the migration while the server works. */
const POLL_MS = { discovering: 2500, running: 3000 } as const;

/**
 * The Notion API migration wizard: connect with an integration secret, let
 * the worker read the workspace, pick pages and their destinations, review,
 * then start the background run and follow it. Closing the dialog is safe at
 * any step: the migration keeps its state, and the connect screen lists the
 * caller's migrations so one can be resumed.
 */
export function NotionMigrationWizard({ open, onClose, initialTarget, canImportToWorkspace }: NotionMigrationWizardProps) {
  const { t } = useTranslation("docs");
  const router = useRouter();
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [migrationId, setMigrationId] = useState<string | null>(null);
  const [migration, setMigration] = useState<MigrationView | null>(null);
  const [selection, setSelection] = useState<RootSelection>(() => new Map());
  const [screen, setScreen] = useState<"pick" | "review">("pick");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultTarget: NotionTargetChoice = canImportToWorkspace && initialTarget === "workspace" ? "workspace" : "private";

  // Each time the dialog opens, start on the connect screen.
  useEffect(() => {
    if (!open) return;
    setMigrationId(null);
    setMigration(null);
    setSelection(new Map());
    setScreen("pick");
    setError(null);
    setBusy(false);
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
  }, [open]);

  const refresh = useCallback(async (id: string) => {
    const next = await getNotionMigrationFn({ data: { id } });
    setMigration(next);
    return next;
  }, []);

  useEffect(() => {
    if (!migrationId) {
      setMigration(null);
      return;
    }
    let cancelled = false;
    refresh(migrationId).catch((err) => {
      if (!cancelled) setError(errorText(err, t("notionMigration.genericError")));
    });
    return () => {
      cancelled = true;
    };
  }, [migrationId, refresh, t]);

  const state = migration?.state ?? null;

  // Scanning and running happen on the server: poll until they stop.
  useEffect(() => {
    if (!migrationId || (state !== "discovering" && state !== "running" && state !== "draft")) return;
    const handle = window.setInterval(
      () => {
        refresh(migrationId).catch(() => undefined);
      },
      state === "running" ? POLL_MS.running : POLL_MS.discovering,
    );
    return () => window.clearInterval(handle);
  }, [migrationId, state, refresh]);

  // Whenever the server state changes, show the pick step for it (review is only for a ready migration).
  useEffect(() => {
    setScreen("pick");
  }, [state]);

  // The imported pages are loader data for the docs sidebar: refresh it once the run is done, as createPage does.
  useEffect(() => {
    if (state === "done") void router.invalidate();
  }, [state, router]);

  const discovery = (migration?.discovery ?? null) as unknown as DiscoveryView | null;
  const tree = useMemo(() => buildNotionTree(discovery?.nodes ?? []), [discovery]);
  const counts = useMemo(() => countSelection(tree, selection), [tree, selection]);
  const roots = useMemo(() => selectionRoots(tree, selection), [tree, selection]);

  // A discovery (first or rescan) lands the migration in "ready". Keep the picks in progress; otherwise restore the saved selection.
  const migrationIdForSelection = migration?.id ?? null;
  useEffect(() => {
    if (state !== "ready" || !migrationIdForSelection) return;
    const saved = (migration?.selection ?? null) as unknown as SavedSelection | null;
    setSelection((prev) => {
      if (prev.size > 0) return selectionFromSaved(tree, [...prev].map(([notionId, target]) => ({ notionId, target })));
      return selectionFromSaved(tree, saved?.roots ?? []);
    });
    // Keyed on the migration and its state: a new discovery or a new migration re-seeds the picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [migrationIdForSelection, state]);

  /** Runs a server action with the busy and error state the buttons need, then re-reads the migration. */
  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      if (migrationId) await refresh(migrationId);
    } catch (err) {
      setError(errorText(err, t("notionMigration.genericError")));
    } finally {
      setBusy(false);
    }
  }

  function openMigration(id: string) {
    setSelection(new Map());
    setScreen("pick");
    setError(null);
    setMigrationId(id);
  }

  function rescan() {
    if (!migration) return;
    act(() => rediscoverNotionFn({ data: { id: migration.id } }));
  }

  function start() {
    if (!migration) return;
    const payload = roots.map((root) => ({ notionId: root.notionId, title: root.title, target: root.target }));
    act(async () => {
      await saveNotionSelectionFn({ data: { id: migration.id, selection: { roots: payload } } });
      await startNotionMigrationFn({ data: { id: migration.id } });
    });
  }

  function openPage(pageId: string | null) {
    onClose();
    if (pageId) void router.navigate({ to: "/docs/$pageId", params: { pageId } });
    else void router.navigate({ to: "/docs" });
  }

  let body: ReactNode;
  if (!migrationId) {
    body = <ConnectView onCreated={(id) => setMigrationId(id)} onOpen={openMigration} />;
  } else if (!migration) {
    body = <SkeletonRows rows={3} />;
  } else if (state === "draft" || state === "discovering") {
    const scanned = Number((migration?.progress as { done?: unknown } | null | undefined)?.done ?? 0);
    body = <DiscoveryView scanned={Number.isFinite(scanned) ? scanned : 0} />;
  } else if (state === "ready") {
    body =
      screen === "review" ? (
        <ReviewStep counts={counts} roots={roots} teams={teams} busy={busy} onBack={() => setScreen("pick")} onStart={start} />
      ) : (
        <PickStep
          tree={tree}
          truncated={discovery?.truncated ?? false}
          selection={selection}
          onChange={setSelection}
          defaultTarget={defaultTarget}
          canImportToWorkspace={canImportToWorkspace}
          teams={teams}
          busy={busy}
          onRescan={rescan}
          onReview={() => setScreen("review")}
        />
      );
  } else {
    body = <RunStep migration={migration} busy={busy} onAct={act} onOpen={openPage} />;
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={t("notionMigration.title")}
      description={t("notionMigration.subtitle")}
      closeLabel={t("common:close")}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t("common:close")}
        </Button>
      }
    >
      {body}
      {error && <p className="mt-3 rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
    </Dialog>
  );
}

function DiscoveryView({ scanned }: { scanned: number }) {
  const { t } = useTranslation("docs");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Spinner size={16} />
        <h3 className="type-headline">{t("notionMigration.discovering.heading")}</h3>
      </div>
      {scanned > 0 && <p className="type-small text-text-2">{t("notionMigration.discovering.scanned", { count: scanned })}</p>}
      <p className="type-small text-text-2">{t("notionMigration.discovering.body")}</p>
    </div>
  );
}

/**
 * Step 1: explain the setup, take the integration secret, check it, then
 * create the migration. Lists the caller's earlier migrations so a run that
 * was left (or failed) can be opened or deleted.
 */
function ConnectView({ onCreated, onOpen }: { onCreated: (migrationId: string) => void; onOpen: (migrationId: string) => void }) {
  const { t } = useTranslation("docs");
  const locale = useIntlLocale();
  const [token, setToken] = useState("");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<ListRow[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const loadPrevious = useCallback(() => listNotionMigrationsFn().then(setPrevious, () => setPrevious([])), []);
  useEffect(() => {
    void loadPrevious();
  }, [loadPrevious]);

  function changeToken(value: string) {
    setToken(value);
    setWorkspace(null);
  }

  async function check() {
    const value = token.trim();
    if (!value) {
      setError(t("notionMigration.setup.required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await checkNotionTokenFn({ data: { token: value } });
      setWorkspace(res.workspaceName || t("notionMigration.setup.unnamedWorkspace"));
    } catch (err) {
      setWorkspace(null);
      setError(errorText(err, t("notionMigration.genericError")));
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const { migrationId } = await createNotionMigrationFn({ data: { token: value } });
      setToken("");
      setWorkspace(null);
      onCreated(migrationId);
    } catch (err) {
      setError(errorText(err, t("notionMigration.genericError")));
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await deleteNotionMigrationFn({ data: { id } });
      setConfirmDelete(null);
      await loadPrevious();
    } catch (err) {
      setError(errorText(err, t("notionMigration.genericError")));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (workspace) void connect();
    else void check();
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="type-headline">{t("notionMigration.setup.heading")}</h3>
        <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px] text-text-2">
          <li>{t("notionMigration.setup.step1")}</li>
          <li>{t("notionMigration.setup.step2")}</li>
          <li>{t("notionMigration.setup.step3")}</li>
        </ol>
      </section>

      <form className="flex max-w-[520px] flex-col gap-3.5" onSubmit={submit}>
        <TokenField
          id="notion-token"
          label={t("notionMigration.setup.tokenLabel")}
          hint={
            <>
              {t("notionMigration.setup.tokenHint")}{" "}
              <a href={NOTION_INTEGRATIONS_URL} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">
                {NOTION_INTEGRATIONS_URL.replace("https://", "")}
              </a>
            </>
          }
          value={token}
          onChange={changeToken}
        />
        {workspace && <p className="type-small text-accent-text">{t("notionMigration.setup.connected", { workspace })}</p>}
        {error && <p className="type-small text-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={check} disabled={busy || !token.trim()}>
            {busy && !workspace ? t("notionMigration.setup.checking") : t("notionMigration.setup.check")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !workspace}>
            {t("notionMigration.setup.continue")}
          </Button>
        </div>
      </form>

      {previous && previous.length > 0 && (
        <section>
          <h4 className="mb-2 text-[13px] font-medium text-text-2">{t("notionMigration.previous.heading")}</h4>
          <ul className="flex flex-col rounded-[8px] border border-border bg-surface">
            {previous.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] text-text">{row.workspaceName || t("notionMigration.previous.noName")}</p>
                  <p className="text-[12.5px] text-text-3">{new Date(row.updatedAt).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}</p>
                </div>
                <StateBadge state={row.state} />
                <Button size="sm" variant="outline" onClick={() => onOpen(row.id)} disabled={busy}>
                  {t("notionMigration.previous.open")}
                </Button>
                {confirmDelete === row.id ? (
                  <>
                    <Button size="sm" variant="danger" onClick={() => remove(row.id)} disabled={busy}>
                      {t("notionMigration.previous.deleteConfirm")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={busy}>
                      {t("common:cancel")}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(row.id)} disabled={busy}>
                    {t("notionMigration.previous.delete")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[12.5px] text-text-3">{t("notionMigration.previous.deleteHint")}</p>
        </section>
      )}
    </div>
  );
}
