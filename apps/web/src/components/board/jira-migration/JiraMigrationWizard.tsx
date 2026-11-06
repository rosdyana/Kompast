import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, type BadgeTone } from "@kompast/ui/Badge";
import { Button } from "@kompast/ui/Button";
import { Dialog } from "@kompast/ui/Dialog";
import { SkeletonRows } from "@kompast/ui/EmptyState";
import { useTranslation } from "@kompast/i18n";
import type { JiraDiscovery, JiraMigrationMapping } from "@kompast/import";
import {
  deleteJiraMigrationFn,
  finishJiraMigrationFn,
  getJiraMigrationFn,
  previewJiraMigrationFn,
  requestJiraDiscoveryFn,
  saveJiraMigrationMappingFn,
  setJiraMigrationAutoSyncFn,
  startJiraMigrationRunFn,
} from "@/lib/server-fns/jira-migration";
import { cn } from "@/lib/cn";
import { ConnectStep, type JiraMigrationRow } from "./ConnectStep";
import { FieldsStep } from "./FieldsStep";
import { PeopleStep, StatusesStep } from "./MappingSteps";
import { AttachmentsStep, ReviewStep, SprintsStep } from "./PlanSteps";
import { RunPanel, ScanPanel, type LatestRun, type RunHistory } from "./RunPanels";
import { errorText, type JiraPreview, type JiraTargets } from "./shared";

type StepKey = "connect" | "scan" | "statuses" | "fields" | "people" | "sprints" | "attachments" | "review" | "run";
const STEPS: StepKey[] = ["connect", "scan", "statuses", "fields", "people", "sprints", "attachments", "review", "run"];
const MAPPING_STEPS: StepKey[] = ["statuses", "fields", "people", "sprints", "attachments", "review"];
const EDITABLE_STATES = new Set(["ready", "synced", "failed"]);
const POLL_MS = 2000;
/** How long after the last mapping edit the draft is saved. */
const AUTOSAVE_DELAY_MS = 1500;

const STATE_TONE: Record<string, BadgeTone> = {
  draft: "neutral",
  discovering: "accent",
  ready: "indigo",
  running: "accent",
  synced: "green",
  completed: "green",
  failed: "danger",
};

type Mapping = JiraMigrationMapping;

type AutosaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/**
 * The JIRA migration wizard for one project. Admins get the full flow (connect,
 * scan, map, review, run); anyone who can see the project sees the status.
 * Polls while the server is scanning or running. Mapping edits stay in local
 * state and are saved when the user leaves a mapping step or starts the run.
 */
export function JiraMigrationWizard({ projectId, boardId, canManage }: { projectId: string; boardId: string; canManage: boolean }) {
  const { t } = useTranslation("board");
  const [data, setData] = useState<Awaited<ReturnType<typeof getJiraMigrationFn>> | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState<StepKey>("connect");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<JiraPreview | null>(null);
  const [draft, setDraft] = useState<Mapping | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** True while the local draft has edits the server doesn't have yet. A server refresh must not overwrite them. */
  const dirty = useRef(false);
  /** Bumped on every mapping edit. A save clears `dirty` only if no edit came in while it was in flight. */
  const latestVersion = useRef(0);
  const [editVersion, setEditVersion] = useState(0);
  /** Saves run one at a time, so an earlier, slower save can't land after a later one. */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const [autosave, setAutosave] = useState<AutosaveStatus>({ kind: "idle" });

  const migration: JiraMigrationRow | null = data?.migration ?? null;
  const targets: JiraTargets | null = data?.targets ?? null;
  const projectRef = data?.projectRef ?? null;
  const latestRun: LatestRun = data?.latestRun ?? null;
  const runs: RunHistory = data?.runs ?? [];
  const state = migration?.state ?? null;
  const stamp = migration ? String(migration.updatedAt) : "";
  const discovery = (migration?.discovery ?? null) as unknown as JiraDiscovery | null;
  const serverMapping = (migration?.mapping ?? null) as unknown as Mapping | null;
  const runFailed = state === "failed" && latestRun?.status === "failed";
  const canEditMapping = state !== null && EDITABLE_STATES.has(state) && !!discovery && !!serverMapping;

  const refresh = useCallback(async () => {
    const next = await getJiraMigrationFn({ data: projectId });
    setData(next);
    return next;
  }, [projectId]);

  /** The same re-read, for children that only need to know it finished. */
  const reload = useCallback(async () => {
    await refresh();
  }, [refresh]);

  useEffect(() => {
    refresh().catch((err) => setLoadError(errorText(err, t("genericError"))));
    // refresh is stable per project; t doesn't change what's loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Scanning and running are server-side and take a while: poll until they finish.
  useEffect(() => {
    if (state !== "discovering" && state !== "running") return;
    const handle = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, POLL_MS);
    return () => window.clearInterval(handle);
  }, [state, refresh]);

  // Follow the server's state: jump to the step that matches it when it changes.
  const defaultStep = migration ? defaultStepFor(migration.state, runFailed) : "connect";
  useEffect(() => {
    setActive(defaultStep);
    setError(null);
  }, [defaultStep]);

  // Reload the draft from the server whenever the row changes, unless the user is mid-edit.
  useEffect(() => {
    if (!dirty.current) setDraft(serverMapping);
  }, [stamp]);

  /** Autosave: AUTOSAVE_DELAY_MS after the last mapping edit, while the mapping is editable. Each edit restarts the timer. */
  useEffect(() => {
    if (editVersion === 0 || !canEditMapping || !migration || !draft) return;
    const version = editVersion;
    const snapshot = draft;
    const migrationId = migration.id;
    const handle = window.setTimeout(() => {
      // A leave-the-step or run save may already have stored these edits.
      if (!dirty.current) return;
      setAutosave({ kind: "saving" });
      persist(migrationId, snapshot, version)
        .then(() => {
          if (latestVersion.current === version) setAutosave({ kind: "saved" });
          refresh().catch(() => undefined);
        })
        .catch((err) => setAutosave({ kind: "error", message: errorText(err, t("genericError")) }));
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(handle);
    // Only a new edit, or the mapping becoming editable (or another migration), restarts the timer.
  }, [editVersion, canEditMapping, migration?.id]);

  // The plan shown in the sprints, review and priorities views is the saved one, so re-read it when the row changes.
  const canPreview = !!migration && !!migration.discovery && !!migration.mapping && state !== "discovering";
  useEffect(() => {
    if (!canPreview || !migration) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    previewJiraMigrationFn({ data: migration.id })
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((err) => {
        if (!cancelled) setError(errorText(err, t("genericError")));
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the row's identity and timestamp: re-read when the row changes, not on every render.
  }, [canPreview, migration?.id, stamp]);

  function setMapping(next: Mapping) {
    dirty.current = true;
    latestVersion.current += 1;
    setDraft(next);
    setEditVersion(latestVersion.current);
  }

  /** Queues a save of one snapshot. Clears `dirty` only if no edit came in after the snapshot was taken. */
  function persist(migrationId: string, snapshot: Mapping, version: number): Promise<void> {
    const run = saveQueue.current.catch(() => undefined).then(async () => {
      await saveJiraMigrationMappingFn({ data: { migrationId, mapping: snapshot } });
      if (latestVersion.current === version) dirty.current = false;
    });
    saveQueue.current = run;
    return run;
  }

  /** Saves the local mapping if it has edits. Throws on failure so the caller can show it. */
  async function saveDraft(): Promise<void> {
    if (!dirty.current || !draft || !migration) return;
    await persist(migration.id, draft, latestVersion.current);
    await refresh();
  }

  /** Runs a server action with the busy and error state the buttons need, then re-reads the row. */
  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refresh();
    } catch (err) {
      setError(errorText(err, t("genericError")));
    } finally {
      setBusy(false);
    }
  }

  async function goTo(step: StepKey) {
    if (step === active || !reachable(step)) return;
    try {
      if (MAPPING_STEPS.includes(active)) await saveDraft();
      setError(null);
      setActive(step);
    } catch (err) {
      setError(errorText(err, t("genericError")));
    }
  }

  function reachable(step: StepKey): boolean {
    if (step === "connect") return true;
    if (!migration) return false;
    switch (step) {
      case "scan":
        return state === "discovering" || state === "draft" || (state === "failed" && !runFailed);
      case "run":
        return state === "running" || state === "synced" || state === "completed" || runFailed;
      default:
        return canEditMapping;
    }
  }

  function rescan() {
    if (!migration) return;
    act(() => requestJiraDiscoveryFn({ data: { migrationId: migration.id } }));
  }

  function startRun() {
    if (!migration) return;
    act(async () => {
      await saveDraft();
      await startJiraMigrationRunFn({ data: { migrationId: migration.id } });
      setActive("run");
    });
  }

  /** A catch-up: reads only what JIRA changed since the last finished run. */
  function syncNow() {
    if (!migration) return;
    act(async () => {
      await startJiraMigrationRunFn({ data: { migrationId: migration.id, mode: "sync" } });
      setActive("run");
    });
  }

  /** The repair path: reads the whole project again. The panel asks for confirmation first. */
  function reimportAll() {
    if (!migration) return;
    act(async () => {
      await startJiraMigrationRunFn({ data: { migrationId: migration.id, mode: "full" } });
      setActive("run");
    });
  }

  /** Retries a failed run in the mode the server picks by default (a sync once a run has finished, else a full import). */
  function retryRun() {
    if (!migration) return;
    act(async () => {
      await startJiraMigrationRunFn({ data: { migrationId: migration.id } });
      setActive("run");
    });
  }

  function setAutoSync(minutes: 15 | 60 | 240 | null) {
    if (!migration) return;
    act(() => setJiraMigrationAutoSyncFn({ data: { migrationId: migration.id, minutes } }));
  }

  /** A completeness check: reads JIRA and Kompast, changes nothing. Shown on the run panel. */
  function checkCompleteness() {
    if (!migration) return;
    act(async () => {
      await startJiraMigrationRunFn({ data: { migrationId: migration.id, mode: "reconcile" } });
      setActive("run");
    });
  }

  /** A catch-up sync, then a completeness check, for the Finish flow. */
  function checkBeforeFinish() {
    if (!migration) return;
    act(async () => {
      await startJiraMigrationRunFn({ data: { migrationId: migration.id, mode: "sync", then: "reconcile" } });
      setActive("run");
    });
  }

  /** Finishes the migration. The server refuses unless a check after the last sync exists and any unexplained differences were acknowledged. */
  function finish(acknowledgedDifferences: boolean) {
    if (!migration) return;
    act(() => finishJiraMigrationFn({ data: { migrationId: migration.id, acknowledgedDifferences } }));
  }

  function remove() {
    if (!migration) return;
    setDeleteOpen(false);
    act(() => deleteJiraMigrationFn({ data: { migrationId: migration.id } }));
  }

  if (loadError) return <p className="rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{loadError}</p>;
  if (data === undefined) return <SkeletonRows rows={3} />;

  const header = (
    <div className="flex flex-wrap items-start gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0 flex-1">
        <h2 className="type-headline">{t("jiraMigration.heading")}</h2>
        <p className="mt-0.5 type-small text-text-2">{t("jiraMigration.subtitle")}</p>
      </div>
      {migration && <Badge tone={STATE_TONE[migration.state] ?? "neutral"}>{t(`jiraMigration.states.${migration.state}`)}</Badge>}
      {migration && canManage && migration.state !== "discovering" && migration.state !== "running" && (
        <button type="button" onClick={() => setDeleteOpen(true)} disabled={busy} className="type-small text-danger hover:underline disabled:opacity-60">
          {t("jiraMigration.deleteLink")}
        </button>
      )}
    </div>
  );

  const deleteDialog = (
    <Dialog
      open={deleteOpen}
      onClose={() => setDeleteOpen(false)}
      title={t("jiraMigration.deleteConfirmTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
            {t("cancel")}
          </Button>
          <Button variant="danger" onClick={remove} disabled={busy}>
            {t("jiraMigration.deleteConfirmButton")}
          </Button>
        </>
      }
    >
      <p className="type-small text-text-2">{t("jiraMigration.deleteConfirmBody")}</p>
    </Dialog>
  );

  // Non-admins see where the migration is, and nothing they can act on.
  if (!canManage) {
    return (
      <section className="rounded-[10px] border border-border bg-surface">
        {header}
        <div className="p-5">
          {!migration ? (
            <p className="type-small text-text-2">{t("jiraMigration.noneForViewers")}</p>
          ) : state === "discovering" || (state === "failed" && !runFailed) ? (
            <ScanPanel migration={migration} canManage={false} busy={busy} onRetry={() => undefined} onTokenSaved={reload} />
          ) : (
            <RunPanel
              migration={migration}
              runs={runs}
              projectRef={projectRef}
              canManage={false}
              busy={busy}
              onSync={() => undefined}
              onReimport={() => undefined}
              onAutoSync={() => undefined}
              onRescan={() => undefined}
              onCheck={() => undefined}
              onCheckBeforeFinish={() => undefined}
              onFinish={() => undefined}
              onRetry={() => undefined}
              onStartOver={() => undefined}
            />
          )}
        </div>
      </section>
    );
  }

  const stepBody = (): ReactNode => {
    switch (active) {
      case "connect":
        return <ConnectStep projectId={projectId} boardId={boardId} migration={migration} onChanged={reload} />;
      case "scan":
        return migration ? (
          <ScanPanel migration={migration} canManage busy={busy} onRetry={rescan} onTokenSaved={reload} />
        ) : null;
      case "run":
        return migration ? (
          <RunPanel
            migration={migration}
            runs={runs}
            projectRef={projectRef}
            canManage
            busy={busy}
            onSync={syncNow}
            onReimport={reimportAll}
            onAutoSync={setAutoSync}
            onRescan={rescan}
            onCheck={checkCompleteness}
            onCheckBeforeFinish={checkBeforeFinish}
            onFinish={finish}
            onRetry={runFailed ? retryRun : rescan}
            onStartOver={remove}
          />
        ) : null;
      default:
        if (!discovery || !draft || !targets) return <p className="type-small text-text-2">{t("jiraMigration.scanFirst")}</p>;
        if (active === "statuses") return <StatusesStep discovery={discovery} targets={targets} mapping={draft} onChange={setMapping} />;
        if (active === "fields") return <FieldsStep preview={preview} targets={targets} mapping={draft} onChange={setMapping} onRescan={rescan} busy={busy} />;
        if (active === "people") return <PeopleStep discovery={discovery} targets={targets} mapping={draft} onChange={setMapping} />;
        if (active === "sprints") return <SprintsStep preview={preview} />;
        if (active === "attachments") return <AttachmentsStep discovery={discovery} mapping={draft} onChange={setMapping} />;
        return (
          <ReviewStep
            discovery={discovery}
            mapping={draft}
            preview={preview}
            issueKey={migration?.jiraProjectKey ?? ""}
            canStart={state !== null && EDITABLE_STATES.has(state)}
            busy={busy}
            onStart={startRun}
          />
        );
    }
  };

  const mappingIndex = MAPPING_STEPS.indexOf(active);
  const showMappingNav = mappingIndex !== -1;
  // The first mapping step goes back to Connect: the scan step is done by then, so it isn't reachable.
  const previousStep: StepKey = mappingIndex > 0 ? MAPPING_STEPS[mappingIndex - 1]! : "connect";
  const nextStep: StepKey | null = mappingIndex !== -1 && mappingIndex < MAPPING_STEPS.length - 1 ? MAPPING_STEPS[mappingIndex + 1]! : null;

  return (
    <section className="rounded-[10px] border border-border bg-surface">
      {header}
      <div className="grid gap-5 p-5 lg:grid-cols-[190px_minmax(0,1fr)]">
        <nav aria-label={t("jiraMigration.stepsLabel")} className="flex gap-1.5 overflow-x-auto lg:flex-col lg:overflow-visible">
          {STEPS.map((step, i) => {
            const isActive = step === active;
            const ok = reachable(step);
            return (
              <button
                key={step}
                type="button"
                disabled={!ok}
                aria-current={isActive ? "step" : undefined}
                onClick={() => goTo(step)}
                className={cn(
                  "flex min-w-max items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[13.5px] transition-colors disabled:cursor-default",
                  isActive ? "bg-accent-soft font-medium text-accent-text" : ok ? "text-text-2 hover:bg-surface-3 hover:text-text" : "text-text-3 opacity-60",
                )}
              >
                <span
                  className={cn(
                    "grid h-5 w-5 flex-none place-items-center rounded-full text-[11px] font-semibold tabular-nums",
                    isActive ? "bg-accent text-bg" : "bg-surface-3 text-text-2",
                  )}
                >
                  {i + 1}
                </span>
                {t(`jiraMigration.steps.${step}`)}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0">
          {!migration && active !== "connect" && <p className="type-small text-text-2">{t("jiraMigration.noneForViewers")}</p>}
          {stepBody()}
          {error && <p className="mt-4 rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{error}</p>}
          {showMappingNav && (
            <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
              <Button variant="ghost" onClick={() => goTo(previousStep)} disabled={busy}>
                {t("jiraMigration.back")}
              </Button>
              <div className="flex items-center gap-3">
                <AutosaveNote status={autosave} />
                {nextStep && (
                  <Button variant="primary" onClick={() => goTo(nextStep)} disabled={busy}>
                    {t("jiraMigration.next")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {deleteDialog}
    </section>
  );
}

/** The autosave status, beside the Back and Next buttons. Empty until the first edit is saved or fails. */
function AutosaveNote({ status }: { status: AutosaveStatus }) {
  const { t } = useTranslation("board");
  if (status.kind === "idle") return null;
  const text = status.kind === "saving" ? t("jiraMigration.autosave.saving") : status.kind === "saved" ? t("jiraMigration.autosave.saved") : status.message;
  return <span role="status" className={cn("type-small", status.kind === "error" ? "text-danger" : "text-text-3")}>{text}</span>;
}

/** Which step to show for a given server state, so the wizard lands where the work is. */
function defaultStepFor(state: string, runFailed: boolean): StepKey {
  switch (state) {
    case "ready":
      return "statuses";
    case "running":
    case "synced":
    case "completed":
      return "run";
    case "failed":
      return runFailed ? "run" : "scan";
    default:
      return "scan";
  }
}
