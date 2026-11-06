import { and, eq, schema, sql, type Json } from "@kompast/db";
import {
  JIRA_MIGRATION_LEASE_MS,
  completeImportRun,
  failImportRun,
  findDueJiraAutoSyncs,
  getJiraMigrationToken,
  listJiraMappingTargets,
  listJiraMigrationRuns,
  markJiraMigrationIdle,
  openJiraReconcileRun,
  saveJiraSyncMetadata,
  setJiraMigrationLastSynced,
  startJiraMigrationRun,
  listPendingImportedAttachments,
  markImportRunRunning,
  markImportedAttachmentFailed,
  markImportedAttachmentStored,
  markJiraMigrationFailed,
  markJiraMigrationSynced,
  putImportedAttachmentBytes,
  releaseJiraMigrationLease,
  renewJiraMigrationLease,
  saveJiraDiscovery,
  summarizeImportedAttachments,
  updateJiraMigrationCursor,
  updateJiraMigrationProgress,
  type AnyDb,
  type AuthContext,
  type ImportedAttachmentSummary,
  type JiraMigrationPublic,
  type PendingImportedAttachment,
  type Tx,
} from "@kompast/core";
import { createJiraClient, JiraApiError, type JiraApiCredentials, type JiraClient } from "./client";
import { discoverJiraMetadata, discoverJiraProject, type JiraDiscovery } from "./discover";
import { enrichJiraIssues, type JiraEnrichStats } from "./enrich";
import { fetchJiraIssuePage, type JiraIssuePage } from "./extract";
import { linkUnavailableAttachment, rewriteAttachmentUrls, rewriteIssueInlineAttachments } from "./inline-attachments";
import { mergeJiraMapping, suggestFieldMappings, suggestJiraMapping, suggestPeopleMapping, type JiraMigrationMapping } from "./mapping";
import {
  comparePage,
  compareSprints,
  emptyReconcileCounts,
  loadReconcileEnv,
  missingKeysOf,
  readImportedIssueKeys,
  readReconcileSnapshot,
  reconcileFieldList,
  reconcileIsClean,
  reconcileJql,
  renumberedKeysOf,
  ReconcileLog,
  type ReconcileCounts,
  type ReconcileDifference,
  type WatcherLists,
} from "./reconcile";
import { collectsOptions, optionValuesOf } from "./fields";
import {
  emptyCounts,
  emptySyncCounts,
  emptySyncNotes,
  finalizeJiraImport,
  loadJiraIssueBatch,
  prepareJiraImport,
  recordCreatedSprintSnapshots,
  resolveUserFromMapping,
  syncImportedSprintStates,
  syncJiraIssueBatch,
  SYNC_OVERLAP_MS,
  type DeferredLink,
  type DeferredParent,
  type JiraImportInput,
  type JiraLoadContext,
  type JiraLoadReport,
  type JiraSyncCounts,
  type JiraSyncLoadContext,
  type JiraSyncNotes,
  type PreparedJiraImport,
} from "./load";
import { changedSinceJql, projectKeysJql, resolveTimeZone } from "./sync";
import type { JiraIssue, JiraUser } from "./types";

/**
 * Batched, resumable JIRA migration. apps/worker claims a migration (lease),
 * then calls runJiraMigrationTick once per claimed row. Each tick does a
 * bounded amount of work and saves its place in jira_migration.cursor, so a
 * crash, a restart or a JIRA rate-limit just means the next tick picks up at
 * the last saved page.
 *
 * - discovering: survey the JIRA project and suggest a mapping -> ready.
 * - running: prepare once, then load one JIRA page per transaction until the
 *   last page, then finalize -> synced.
 *
 * Every tenant-facing write runs as the migration's creator through
 * `withTenantAs` (withAuthorizedTenant in production). If the creator has
 * left the workspace, that write fails and the failure is recorded.
 */

export interface JiraMigrationRunnerDeps {
  /** Admin connection: lease bookkeeping, the token read, and the fallback that records a failure when the creator's own transaction can't. */
  adminDb: AnyDb;
  /** Runs `fn` in a tenant-scoped transaction as `ctx.userId`. withAuthorizedTenant in production. */
  withTenantAs: <T>(ctx: AuthContext, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Defaults to the real JIRA client. Tests inject one whose fetch is mocked. */
  createClient?: (creds: JiraApiCredentials) => JiraClient;
  now?: () => Date;
  /** Stop starting new pages after this long, so a tick stays well inside the lease. Default 4 minutes. */
  timeBudgetMs?: number;
}

/** Saved resume state. Lives in jira_migration.cursor as plain JSON. */
export interface JiraMigrationCursor {
  importRunId: string;
  /** "full" (the default, and what a cursor from before modes existed is). "sync" cursors are JiraSyncCursor. */
  mode?: "full" | "sync";
  /** When this run started reading JIRA. Becomes lastSyncedAt when the run finishes (its attachments phase included). */
  startedAt?: string;
  /** Token for the next page to fetch. Null means the first page. */
  nextPageToken: string | null;
  pagesDone: number;
  /** Consecutive failed attempts on the current page. Reset to 0 on success. */
  attemptsOnPage: number;
  deferredParents: DeferredParent[];
  deferredLinks: DeferredLink[];
  /** Set by the first tick. Reused by every later tick so the set-up never runs twice. */
  prepared?: PreparedJiraImport;
  /** Running totals across pages. Missing on a cursor that hasn't run a page yet. */
  counts?: JiraLoadReport["counts"];
  errors?: JiraLoadReport["errors"];
  /** Informational notes across pages (renumbered issues). Missing on an older cursor. */
  notes?: JiraLoadReport["notes"];
}

/**
 * Saved resume state of the attachments phase. The data phase's fields are gone: the run's
 * issues are all in, and this phase only copies files. The totals are for this phase.
 */
export interface JiraMigrationAttachmentCursor {
  importRunId: string;
  phase: "attachments";
  /** The run's start, carried from the data phase (or the sync). Becomes lastSyncedAt once the copies are done. */
  lastSyncedAt?: string;
  attachmentsStored: number;
  attachmentsFailed: number;
  attachmentBytesStored: number;
  inlineBlocksRewritten: number;
  /** A sync chained into a reconcile: when the copies are done, the reconcile starts instead of the migration going synced. */
  then?: "reconcile";
}

/** What one tick got through, for its log line. */
interface JiraTickTally {
  pages: number;
  issues: number;
}

const DEFAULT_TIME_BUDGET_MS = 4 * 60_000;
const MAX_PAGE_ATTEMPTS = 3;
const PAGE_SIZE = 100;
/** The attachments phase copies at most this many files, and this many bytes, per slice. */
const ATTACHMENT_SLICE_FILES = 25;
const ATTACHMENT_SLICE_BYTES = 200 * 1024 * 1024;
/** Parallel downloads per slice. */
const ATTACHMENT_CONCURRENCY = 4;
/** A download may run this far past the size JIRA declared before it is cut off. */
const ATTACHMENT_SIZE_SLACK_BYTES = 1024 * 1024;
/** Discovery writes its running count at most this often. */
const DISCOVERY_PROGRESS_INTERVAL_MS = 2_000;

function defaultClient(creds: JiraApiCredentials): JiraClient {
  return createJiraClient(creds);
}

function ctxOf(migration: JiraMigrationPublic): AuthContext {
  return { userId: migration.createdBy, organizationId: migration.organizationId };
}

/** The one place a typed value becomes the jsonb Json type. Every value passed here is plain JSON by construction (JSON-serializable discovery/mapping/cursor). */
function toJson(value: unknown): Json {
  return value as Json;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readCursor(raw: Json | null): JiraMigrationCursor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The migration is running but has no cursor");
  const c = raw as unknown as JiraMigrationCursor;
  return {
    ...c,
    nextPageToken: c.nextPageToken ?? null,
    pagesDone: c.pagesDone ?? 0,
    attemptsOnPage: c.attemptsOnPage ?? 0,
    deferredParents: c.deferredParents ?? [],
    deferredLinks: c.deferredLinks ?? [],
  };
}

/** Adds two count sets. A key missing on either side (a cursor saved before the key existed) counts as 0. */
function addCounts(a: JiraLoadReport["counts"], b: JiraLoadReport["counts"]): JiraLoadReport["counts"] {
  const out = emptyCounts();
  for (const k of Object.keys(out) as (keyof JiraLoadReport["counts"])[]) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

/** The enrichment requests of one page, as report counts. */
function enrichCountsOf(stats: JiraEnrichStats): JiraLoadReport["counts"] {
  return {
    ...emptyCounts(),
    commentPagesFetched: stats.commentPages,
    changelogPagesFetched: stats.changelogPages,
    worklogPagesFetched: stats.worklogPages,
    watcherCalls: stats.watcherCalls,
    renderedDescriptionCalls: stats.renderedDescriptionCalls,
    renderedCommentCalls: stats.renderedCommentCalls,
    mediaMatchedByPosition: stats.mediaMatchedByPosition,
    mediaPositionMismatch: stats.mediaPositionMismatch,
  };
}

/** Every enrichment request one page made: paged comments, changelog, worklogs, watchers and rendered-HTML calls. */
function enrichCallCountOf(stats: JiraEnrichStats): number {
  return stats.commentPages + stats.changelogPages + stats.worklogPages + stats.watcherCalls + stats.renderedDescriptionCalls + stats.renderedCommentCalls;
}

/** The JIRA story-points custom field's id, from discovery. Its name differs by site, so it's also matched by its schema. */
function storyPointsFieldIdOf(discovery: JiraDiscovery): string | undefined {
  return discovery.fields.find(
    (f) => f.name === "Story point estimate" || f.name === "Story Points" || f.schemaCustom === "com.pyxis.greenhopper.jira:jsw-story-points",
  )?.id;
}

async function requireToken(deps: JiraMigrationRunnerDeps, migrationId: string): Promise<string> {
  const token = await getJiraMigrationToken(deps.adminDb, migrationId);
  if (!token) throw new Error("The JIRA API token for this migration is gone — enter it again to continue");
  return token;
}

function clientFor(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, token: string): JiraClient {
  const creds: JiraApiCredentials = { baseUrl: migration.siteUrl, email: migration.email, apiToken: token };
  return (deps.createClient ?? defaultClient)(creds);
}

/** JQL for the project's issues, oldest key first. The same query every page of the load uses. */
function projectJql(projectKey: string): string {
  return `project = "${projectKey.replace(/"/g, '\\"')}" ORDER BY key ASC`;
}

/**
 * Records a failure against the migration (and its import run, if one
 * exists). Tries as the creator first. If that fails (for example, the
 * creator left the workspace), it falls back to the admin connection so the
 * failure still lands in the row.
 */
async function recordFailure(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, message: string, importRunId: string | null): Promise<void> {
  const write = async (db: AnyDb) => {
    if (importRunId) await failImportRun(db, importRunId, message);
    await markJiraMigrationFailed(db, migration.id, message);
  };
  try {
    await deps.withTenantAs(ctxOf(migration), (tx) => write(tx));
  } catch {
    await write(deps.adminDb);
  }
}

/**
 * Runs one bounded slice of work for a claimed migration, then releases its
 * lease. Never throws: a failure is recorded on the migration row instead, so
 * the worker's loop keeps going for the other claimed migrations.
 */
export async function runJiraMigrationTick(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic): Promise<void> {
  const tickStarted = Date.now();
  const tally: JiraTickTally = { pages: 0, issues: 0 };
  try {
    if (migration.state === "discovering") await runDiscovery(deps, migration);
    else if (migration.state === "running" && isAttachmentCursor(migration.cursor)) await runAttachments(deps, migration);
    else if (migration.state === "running" && isSyncCursor(migration.cursor)) await runSync(deps, migration, tally);
    else if (migration.state === "running" && isReconcileCursor(migration.cursor)) await runReconcile(deps, migration, tally);
    else if (migration.state === "running") await runLoad(deps, migration, tally);
  } catch (err) {
    const importRunId = migration.state === "running" ? (migration.cursor as { importRunId?: string } | null)?.importRunId ?? null : null;
    await recordFailure(deps, migration, errorMessage(err), importRunId).catch((recordErr) => {
      console.error(`[jira-migration] could not record failure for ${migration.id}:`, recordErr);
    });
  } finally {
    if (migration.state === "running") {
      console.log(`[jira-migration] ${migration.id} tick: ${Date.now() - tickStarted} ms, ${tally.pages} pages, ${tally.issues} issues`);
    }
    await releaseJiraMigrationLease(deps.adminDb, migration.id).catch((releaseErr) => {
      console.error(`[jira-migration] could not release lease for ${migration.id}:`, releaseErr);
    });
  }
}

/**
 * Writes discovery's running count to the migration row, at most every
 * DISCOVERY_PROGRESS_INTERVAL_MS. Best effort: a failed write is logged and
 * never fails the scan. settle() waits for the writes already started, so a
 * late progress write can't land after the scan's result is saved.
 */
function discoveryProgressWriter(deps: JiraMigrationRunnerDeps, migrationId: string) {
  const now = deps.now ?? (() => new Date());
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> = Promise.resolve();
  return {
    note(scanned: number): void {
      const at = now().getTime();
      if (at - lastWriteAt < DISCOVERY_PROGRESS_INTERVAL_MS) return;
      lastWriteAt = at;
      const write = updateJiraMigrationProgress(deps.adminDb, migrationId, toJson({ phase: "discovery", done: scanned, total: null })).catch((err) => {
        console.error(`[jira-migration] could not record discovery progress for ${migrationId}:`, err);
      });
      pending = pending.then(() => write);
    },
    settle(): Promise<void> {
      return pending;
    },
  };
}

async function runDiscovery(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic): Promise<void> {
  const token = await requireToken(deps, migration.id);
  const client = clientFor(deps, migration, token);
  const progress = discoveryProgressWriter(deps, migration.id);
  const discovery = await discoverJiraProject(client, {
    projectKey: migration.jiraProjectKey,
    boardId: migration.jiraBoardId ?? undefined,
    onProgress: (scanned) => progress.note(scanned),
  });
  await progress.settle();

  await deps.withTenantAs(ctxOf(migration), async (tx) => {
    const targets = await listJiraMappingTargets(tx, migration.projectId, migration.boardId);
    const suggested = suggestJiraMapping(discovery, targets);
    // A re-scan keeps the choices the user already made where they still hold.
    const previous = migration.mapping as unknown as JiraMigrationMapping | null;
    const mapping = previous ? mergeJiraMapping(previous, suggested, targets) : suggested;
    await saveJiraDiscovery(tx, migration.id, toJson(discovery), toJson(mapping));
  });
}

/** The import input a migration's prepare step needs, from the discovery snapshot. */
function importInputFromDiscovery(discovery: JiraDiscovery, mapping: JiraMigrationMapping): JiraImportInput {
  return {
    statuses: discovery.statuses,
    types: discovery.issueTypes.map((t) => ({ name: t.name })),
    sprints: discovery.sprints,
    mapping,
    fieldOptions: discovery.fieldOptions,
  };
}

async function runLoad(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, tally: JiraTickTally): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const budgetMs = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const started = Date.now();
  const ctx = ctxOf(migration);

  const discovery = migration.discovery as unknown as JiraDiscovery | null;
  const mapping = migration.mapping as unknown as JiraMigrationMapping | null;
  if (!discovery || !mapping) throw new Error("The migration has no discovery or mapping to run from");

  const token = await requireToken(deps, migration.id);
  const client = clientFor(deps, migration, token);
  const jql = projectJql(migration.jiraProjectKey);
  const total = discovery.issueCount ?? null;

  const loadCtxFor = (importRunId: string, prepared?: PreparedJiraImport): JiraLoadContext => ({
    organizationId: migration.organizationId,
    projectId: migration.projectId,
    boardId: migration.boardId,
    importRunId,
    actorUserId: migration.createdBy,
    dryRun: false,
    jiraBaseUrl: migration.siteUrl,
    jiraProjectKey: migration.jiraProjectKey,
    storyPointsFieldId: storyPointsFieldIdOf(discovery),
    resolveUserId: resolveUserFromMapping(mapping, prepared?.formerUserIdByAccount ?? {}),
    // The bytes are copied by the attachments phase, so the load only writes placeholders.
    migrationAttachments: { maxBytes: mapping.attachmentMaxBytes },
  });

  let cursor = readCursor(migration.cursor);
  let done = (migration.progress as { done?: number } | null)?.done ?? 0;
  const progressOf = (d: number) => toJson({ phase: "data", done: d, total });
  const importRunId = cursor.importRunId;

  // First tick only: set the run up (statuses, types, sprints) and save the
  // result in the cursor, so later ticks and restarts don't repeat it.
  if (cursor.pagesDone === 0 && !cursor.prepared) {
    cursor = await deps.withTenantAs(ctx, async (tx) => {
      await markImportRunRunning(tx, importRunId);
      const prepared = await prepareJiraImport(tx, loadCtxFor(importRunId), importInputFromDiscovery(discovery, mapping));
      const next: JiraMigrationCursor = { ...cursor, prepared };
      await updateJiraMigrationCursor(tx, migration.id, toJson(next), progressOf(done));
      return next;
    });
  }

  const persistCursor = (next: JiraMigrationCursor, d: number) =>
    deps.withTenantAs(ctx, (tx) => updateJiraMigrationCursor(tx, migration.id, toJson(next), progressOf(d)));

  while (Date.now() - started <= budgetMs) {
    let page: JiraIssuePage;
    const fetchStarted = Date.now();
    try {
      page = await fetchJiraIssuePage(client, jql, {
        nextPageToken: cursor.nextPageToken ?? undefined,
        fields: "*all",
        expand: "changelog",
        maxResults: PAGE_SIZE,
      });
    } catch (err) {
      // A stale token (JIRA rejects the saved page token) fails the same way
      // twice in a row. Restart from the first page: the prepared set-up is
      // kept, and reloading is safe because issues are idempotent via external_ref.
      const staleToken = err instanceof JiraApiError && err.status === 400 && cursor.nextPageToken !== null;
      if (staleToken && cursor.attemptsOnPage >= 1) {
        cursor = { ...cursor, nextPageToken: null, pagesDone: 0, attemptsOnPage: 0, deferredParents: [], deferredLinks: [] };
        done = 0;
        await persistCursor(cursor, done);
        continue;
      }
      const attemptsOnPage = cursor.attemptsOnPage + 1;
      if (attemptsOnPage >= MAX_PAGE_ATTEMPTS) {
        await recordFailure(deps, migration, errorMessage(err), importRunId);
        return;
      }
      cursor = { ...cursor, attemptsOnPage };
      await persistCursor(cursor, done);
      return;
    }

    const fetchMs = Date.now() - fetchStarted;

    // Comments, changelog, worklogs and watchers the search response only partly embeds. Fetched here,
    // before the transaction opens, so no network call ever runs inside a tx.
    let enrichStats: JiraEnrichStats = {
      commentPages: 0,
      changelogPages: 0,
      worklogPages: 0,
      watcherCalls: 0,
      renderedDescriptionCalls: 0,
      renderedCommentCalls: 0,
      mediaMatchedByPosition: 0,
      mediaPositionMismatch: 0,
    };
    const enrichStarted = Date.now();
    try {
      const enriched = await enrichJiraIssues(client, page.issues);
      page = { ...page, issues: enriched.issues };
      enrichStats = enriched.stats;
    } catch (err) {
      const attemptsOnPage = cursor.attemptsOnPage + 1;
      if (attemptsOnPage >= MAX_PAGE_ATTEMPTS) {
        await recordFailure(deps, migration, errorMessage(err), importRunId);
        return;
      }
      cursor = { ...cursor, attemptsOnPage };
      await persistCursor(cursor, done);
      return;
    }

    const enrichMs = Date.now() - enrichStarted;

    try {
      const finished = await deps.withTenantAs(ctx, async (tx) => {
        const prepared = cursor.prepared!;
        const loadStarted = Date.now();
        const batch = await loadJiraIssueBatch(tx, page.issues, loadCtxFor(importRunId, prepared), prepared);
        const loadMs = Date.now() - loadStarted;
        const deferredParents = [...cursor.deferredParents, ...batch.deferredParents];
        const deferredLinks = [...cursor.deferredLinks, ...batch.deferredLinks];
        const counts = addCounts(cursor.counts ?? emptyCounts(), addCounts(batch.counts, enrichCountsOf(enrichStats)));
        const errors = [...(cursor.errors ?? []), ...batch.errors];
        const notes = [...(cursor.notes ?? []), ...batch.notes];
        const nextDone = done + page.issues.length;
        const next: JiraMigrationCursor = {
          ...cursor,
          nextPageToken: page.nextPageToken ?? null,
          pagesDone: cursor.pagesDone + 1,
          attemptsOnPage: 0,
          deferredParents,
          deferredLinks,
          counts,
          errors,
          notes,
        };

        if (!page.isLast) {
          const cursorStarted = Date.now();
          await updateJiraMigrationCursor(tx, migration.id, toJson(next), progressOf(nextDone));
          return { finished: false as const, next, nextDone, loadMs, cursorMs: Date.now() - cursorStarted };
        }

        // Last page: finish the deferred work and close the run in this same transaction.
        const fin = await finalizeJiraImport(tx, loadCtxFor(importRunId, prepared), prepared, { deferredParents, deferredLinks });
        const finalCounts = {
          ...counts,
          parentLinksResolved: counts.parentLinksResolved + fin.counts.parentLinksResolved,
          linksCreated: counts.linksCreated + fin.counts.linksCreated,
          issueMentionsResolved: counts.issueMentionsResolved + fin.counts.issueMentionsResolved,
          issueMentionsUnresolved: counts.issueMentionsUnresolved + fin.counts.issueMentionsUnresolved,
          // Created once by the prepare step, not by any page.
          statusesCreated: counts.statusesCreated + prepared.counts.statusesCreated,
          typesCreated: counts.typesCreated + prepared.counts.typesCreated,
          sprintsCreated: counts.sprintsCreated + prepared.counts.sprintsCreated,
          formerMembersCreated: counts.formerMembersCreated + (prepared.counts.formerMembersCreated ?? 0),
          propertiesCreated: counts.propertiesCreated + (prepared.counts.propertiesCreated ?? 0),
        };
        await completeImportRun(tx, importRunId, toJson(finalCounts), toJson([...errors, ...fin.errors]), toJson(notes));
        // Files the load left pending go to the attachments phase. A project with none goes straight to synced.
        const summary = await summarizeImportedAttachments(tx, migration.projectId);
        const cursorStarted = Date.now();
        if (summary.counts.pending > 0) {
          const attachmentCursor: JiraMigrationAttachmentCursor = {
            importRunId,
            phase: "attachments",
            lastSyncedAt: cursor.startedAt,
            attachmentsStored: 0,
            attachmentsFailed: 0,
            attachmentBytesStored: 0,
            inlineBlocksRewritten: 0,
          };
          await updateJiraMigrationCursor(tx, migration.id, toJson(attachmentCursor), attachmentProgressOf(summary));
        } else {
          await updateJiraMigrationCursor(tx, migration.id, toJson(next), progressOf(nextDone));
          await markJiraMigrationSynced(tx, migration.id, cursor.startedAt ? new Date(cursor.startedAt) : now());
        }
        const cursorMs = Date.now() - cursorStarted;
        return { finished: true as const, next, nextDone, loadMs, cursorMs };
      });

      cursor = finished.next;
      done = finished.nextDone;
      tally.pages++;
      tally.issues += page.issues.length;
      console.log(
        `[jira-migration] ${migration.id} page ${cursor.pagesDone}: fetch ${fetchMs} enrich ${enrichMs} (${enrichCallCountOf(enrichStats)} calls) load ${finished.loadMs} cursor ${finished.cursorMs} issues ${page.issues.length}`,
      );
      if (finished.finished) return;
      await renewJiraMigrationLease(deps.adminDb, migration.id, JIRA_MIGRATION_LEASE_MS);
    } catch (err) {
      // The page's load transaction rolled back, so the cursor still points at this page. Count the attempt.
      const attemptsOnPage = cursor.attemptsOnPage + 1;
      if (attemptsOnPage >= MAX_PAGE_ATTEMPTS) {
        await recordFailure(deps, migration, errorMessage(err), importRunId);
        return;
      }
      cursor = { ...cursor, attemptsOnPage };
      await persistCursor(cursor, done);
      return;
    }
  }
}

// ── Attachments phase ───────────────────────────────────────────────────────

function isAttachmentCursor(raw: Json | null): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { phase?: unknown }).phase === "attachments";
}

function readAttachmentCursor(raw: Json | null): JiraMigrationAttachmentCursor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The migration is copying attachments but has no cursor");
  const c = raw as unknown as JiraMigrationAttachmentCursor;
  return {
    ...c,
    attachmentsStored: c.attachmentsStored ?? 0,
    attachmentsFailed: c.attachmentsFailed ?? 0,
    attachmentBytesStored: c.attachmentBytesStored ?? 0,
    inlineBlocksRewritten: c.inlineBlocksRewritten ?? 0,
  };
}

/** The attachments phase's progress, as the wizard shows it. `done`/`total` count files, the byte fields count bytes. */
function attachmentProgressOf(s: ImportedAttachmentSummary): Json {
  return toJson({
    phase: "attachments",
    done: s.counts.stored,
    total: s.counts.stored + s.counts.pending + s.counts.failed,
    bytesDone: s.bytesStored,
    bytesTotal: s.bytesCopyable,
    failed: s.counts.failed,
    notMigrated: s.counts.not_migrated,
  });
}

/** Runs fn over items with at most `limit` in flight. Results keep the input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** The first files of a list that fit one slice: at most ATTACHMENT_SLICE_FILES, and ATTACHMENT_SLICE_BYTES unless the first file alone is bigger. */
function pickSlice(rows: PendingImportedAttachment[]): PendingImportedAttachment[] {
  const picked: PendingImportedAttachment[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (picked.length >= ATTACHMENT_SLICE_FILES) break;
    if (picked.length > 0 && bytes + row.sizeBytes > ATTACHMENT_SLICE_BYTES) break;
    picked.push(row);
    bytes += row.sizeBytes;
  }
  return picked;
}

/**
 * Reads a response body into a Buffer, cutting it off once it passes `limit` bytes. The limit is the
 * size JIRA declared for the file plus a little slack, so a body that grows past it is not kept.
 */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > limit) throw new Error(`JIRA sent more bytes than the ${limit} it declared for this file`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error(`JIRA sent more bytes than the ${limit} it declared for this file`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

type FetchedAttachment =
  | { row: PendingImportedAttachment; ok: true; storageKey: string; sizeBytes: number; contentType: string }
  | { row: PendingImportedAttachment; ok: false; error: string; permanent: boolean };

/**
 * Downloads one file from JIRA, then writes its bytes to storage. Runs outside any transaction.
 * A 404 from JIRA means the attachment is gone there: that failure is permanent.
 */
async function fetchAndStore(client: JiraClient, siteUrl: string, row: PendingImportedAttachment): Promise<FetchedAttachment> {
  if (!row.jiraAttachmentId) return { row, ok: false, error: "No JIRA attachment id is recorded for this file", permanent: true };
  const url = `${siteUrl.replace(/\/+$/, "")}/rest/api/3/attachment/content/${row.jiraAttachmentId}`;
  try {
    const res = await client.getRaw(url);
    const data = await readCapped(res, row.sizeBytes + ATTACHMENT_SIZE_SLACK_BYTES);
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim() || row.contentType;
    const { storageKey } = await putImportedAttachmentBytes({ issueId: row.issueId, attachmentId: row.attachmentId, fileName: row.fileName, contentType, data });
    return { row, ok: true, storageKey, sizeBytes: data.byteLength, contentType };
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 404) {
      return { row, ok: false, error: "JIRA returned 404 for this attachment: it was probably deleted in JIRA", permanent: true };
    }
    return { row, ok: false, error: errorMessage(err), permanent: false };
  }
}

/**
 * Copies the migration's pending files, a slice at a time, until none are left or the tick's time budget is
 * spent. Each slice downloads outside any transaction, then records every file in its own short tenant
 * transaction. A file that fails is retried on a later slice, and fails for good after three attempts (or
 * at once when JIRA says it's gone). Once no file is pending, the run is closed and the migration is synced.
 */
async function runAttachments(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const budgetMs = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const started = Date.now();
  const ctx = ctxOf(migration);
  const cursor = readAttachmentCursor(migration.cursor);
  const token = await requireToken(deps, migration.id);
  const client = clientFor(deps, migration, token);

  while (Date.now() - started <= budgetMs) {
    const rows = await deps.withTenantAs(ctx, (tx) => listPendingImportedAttachments(tx, migration.projectId, ATTACHMENT_SLICE_FILES));
    const slice = pickSlice(rows);
    if (slice.length === 0) break;

    const fetched = await mapWithConcurrency(slice, ATTACHMENT_CONCURRENCY, (row) => fetchAndStore(client, migration.siteUrl, row));
    for (const result of fetched) {
      const { row } = result;
      const jiraId = row.jiraAttachmentId;
      try {
        if (result.ok) {
          const rewritten = await deps.withTenantAs(ctx, async (tx) => {
            await markImportedAttachmentStored(tx, { attachmentId: row.attachmentId, storageKey: result.storageKey, sizeBytes: result.sizeBytes, contentType: result.contentType });
            if (!jiraId) return 0;
            return rewriteIssueInlineAttachments(tx, row.issueId, jiraId, (value) =>
              rewriteAttachmentUrls(value, jiraId, `/api/issue-attachments/${row.attachmentId}`),
            );
          });
          cursor.attachmentsStored++;
          cursor.attachmentBytesStored += result.sizeBytes;
          cursor.inlineBlocksRewritten += rewritten;
        } else {
          const status = await deps.withTenantAs(ctx, async (tx) => {
            const marked = await markImportedAttachmentFailed(tx, { attachmentId: row.attachmentId, error: result.error, permanent: result.permanent });
            if (marked.status === "failed" && jiraId) {
              // The file is not coming: its inline references become links to the JIRA page.
              await rewriteIssueInlineAttachments(tx, row.issueId, jiraId, (value) =>
                linkUnavailableAttachment(value, jiraId, { fileName: row.fileName, sourceUrl: row.sourceUrl ?? "" }),
              );
            }
            return marked.status;
          });
          if (status === "failed") cursor.attachmentsFailed++;
        }
      } catch (err) {
        // The row stays pending, so a later slice tries it again. Logged, not thrown: one file must not stop the rest.
        console.error(`[jira-migration] could not record attachment ${row.attachmentId} for ${migration.id}:`, err);
      }
    }

    const summary = await deps.withTenantAs(ctx, async (tx) => {
      const s = await summarizeImportedAttachments(tx, migration.projectId);
      await updateJiraMigrationCursor(tx, migration.id, toJson(cursor), attachmentProgressOf(s));
      return s;
    });
    await renewJiraMigrationLease(deps.adminDb, migration.id, JIRA_MIGRATION_LEASE_MS);
    console.log(`[jira-migration] ${migration.id} attachments: slice of ${slice.length}, ${summary.counts.stored} stored, ${summary.counts.pending} pending, ${summary.counts.failed} failed`);
  }

  const remaining = await deps.withTenantAs(ctx, (tx) => summarizeImportedAttachments(tx, migration.projectId));
  if (remaining.counts.pending > 0) return;

  // Nothing pending: close the run with the copy totals, and sync the migration (or start the chained reconcile).
  await deps.withTenantAs(ctx, async (tx) => {
    const [run] = await tx.select({ counts: schema.importRun.counts }).from(schema.importRun).where(eq(schema.importRun.id, cursor.importRunId));
    const merged = {
      ...((run?.counts ?? {}) as Record<string, unknown>),
      attachmentsStored: cursor.attachmentsStored,
      attachmentsFailed: cursor.attachmentsFailed,
      attachmentBytesStored: cursor.attachmentBytesStored,
      inlineBlocksRewritten: cursor.inlineBlocksRewritten,
    };
    await tx.update(schema.importRun).set({ counts: toJson(merged) }).where(eq(schema.importRun.id, cursor.importRunId));
    const at = cursor.lastSyncedAt ? new Date(cursor.lastSyncedAt) : now();
    if (cursor.then === "reconcile") await chainReconcile(tx, migration, at);
    else await markJiraMigrationSynced(tx, migration.id, at);
  });
}

/**
 * Sets the migration's lastSyncedAt and starts a reconcile in its place: the migration stays "running" with the
 * reconcile's cursor, and the reconcile's run is opened now (its own import_run, mode reconcile).
 */
async function chainReconcile(tx: Tx, migration: JiraMigrationPublic, syncedAt: Date): Promise<void> {
  await setJiraMigrationLastSynced(tx, migration.id, syncedAt);
  const { cursor } = await openJiraReconcileRun(tx, migration, migration.createdBy, new Date());
  await updateJiraMigrationCursor(tx, migration.id, toJson(cursor), toJson({ phase: "reconcile", done: 0, total: null }));
}

// ── Catch-up sync ───────────────────────────────────────────────────────────

/**
 * Saved resume state of a sync. It goes through five phases, each saved as it goes:
 * metadata (statuses, types, priorities, fields, board sprints: refreshed, created, and sprint states brought up to
 * date) → changed (issues JIRA changed since the previous run, one page at a time) → keys (every key the project
 * has now) → missing (imported keys JIRA no longer lists: 404 means deleted, another key means moved) → finish.
 */
export interface JiraSyncCursor {
  importRunId: string;
  mode: "sync";
  /** When this sync started reading JIRA. Becomes lastSyncedAt when the sync finishes. */
  startedAt: string;
  phase: "metadata" | "changed" | "keys" | "missing" | "finish";
  nextPageToken: string | null;
  pagesDone: number;
  attemptsOnPage: number;
  issuesRead: number;
  deferredParents: DeferredParent[];
  deferredLinks: DeferredLink[];
  /** Set by the metadata phase, refreshed when a page brings people or fields the mapping doesn't have. */
  prepared?: PreparedJiraImport;
  counts: JiraSyncCounts;
  errors: JiraLoadReport["errors"];
  notes: JiraSyncNotes;
  /** Every key the project has, collected by the keys phase. */
  keysSeen: string[];
  /** Imported keys the keys phase did not see. Checked one by one in the missing phase. */
  missing: string[];
  missingIndex: number;
  /** "reconcile": when the sync's data is in, a reconcile run starts (the migration stays running until it ends). */
  then?: "reconcile";
}

const SYNC_KEYS_PAGE_SIZE = 1000;

function isSyncCursor(raw: Json | null): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { mode?: unknown }).mode === "sync";
}

function readSyncCursor(raw: Json | null): JiraSyncCursor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The sync is running but has no cursor");
  const c = raw as unknown as Partial<JiraSyncCursor> & { importRunId: string; startedAt: string };
  return {
    importRunId: c.importRunId,
    mode: "sync",
    startedAt: c.startedAt,
    phase: c.phase ?? "metadata",
    nextPageToken: c.nextPageToken ?? null,
    pagesDone: c.pagesDone ?? 0,
    attemptsOnPage: c.attemptsOnPage ?? 0,
    issuesRead: c.issuesRead ?? 0,
    deferredParents: c.deferredParents ?? [],
    deferredLinks: c.deferredLinks ?? [],
    prepared: c.prepared,
    counts: { ...emptySyncCounts(), ...(c.counts ?? {}) },
    errors: c.errors ?? [],
    notes: { ...emptySyncNotes(), ...(c.notes ?? {}) },
    keysSeen: c.keysSeen ?? [],
    missing: c.missing ?? [],
    missingIndex: c.missingIndex ?? 0,
    ...(c.then ? { then: c.then } : {}),
  };
}

/** The import input for a sync's prepare step, and the load context every sync write uses. */
function syncLoadCtxOf(migration: JiraMigrationPublic, importRunId: string, discovery: JiraDiscovery, mapping: JiraMigrationMapping, prepared?: PreparedJiraImport): JiraSyncLoadContext {
  return {
    organizationId: migration.organizationId,
    projectId: migration.projectId,
    boardId: migration.boardId,
    importRunId,
    actorUserId: migration.createdBy,
    dryRun: false,
    jiraBaseUrl: migration.siteUrl,
    jiraProjectKey: migration.jiraProjectKey,
    storyPointsFieldId: storyPointsFieldIdOf(discovery),
    resolveUserId: resolveUserFromMapping(mapping, prepared?.formerUserIdByAccount ?? {}),
    migrationAttachments: { maxBytes: mapping.attachmentMaxBytes },
    previousSyncedAt: new Date(migration.lastSyncedAt!),
  };
}

/** The lists a prepare or a metadata refresh added, for the run's notes: names of statuses, types and properties by key. */
async function namesOfProjectSetup(tx: Tx, projectId: string): Promise<{ statuses: Set<string>; types: Set<string>; properties: Map<string, string> }> {
  const statuses = await tx.select({ name: schema.workflowStatus.name }).from(schema.workflowStatus).where(eq(schema.workflowStatus.projectId, projectId));
  const types = await tx.select({ name: schema.issueType.name }).from(schema.issueType).where(eq(schema.issueType.projectId, projectId));
  const properties = await tx.select({ key: schema.issuePropertyDefinition.key, name: schema.issuePropertyDefinition.name }).from(schema.issuePropertyDefinition).where(eq(schema.issuePropertyDefinition.projectId, projectId));
  return {
    statuses: new Set(statuses.map((r) => r.name.toLowerCase())),
    types: new Set(types.map((r) => r.name.toLowerCase())),
    properties: new Map(properties.map((r) => [r.key, r.name])),
  };
}

/** Board sprints from the saved discovery and the fresh list, deduped by id (the fresh one wins). */
function mergeSprintLists(previous: JiraDiscovery["sprints"], fresh: JiraDiscovery["sprints"]): JiraDiscovery["sprints"] {
  const byId = new Map(previous.map((s) => [s.id, s]));
  for (const s of fresh) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * The metadata phase: JIRA's statuses, types, priorities, fields and board sprints, read now (no issue scan). The
 * mapping is merged with the fresh suggestion, the prepare step creates what's new, and the sprints the sync already
 * imported are brought to JIRA's state. The read happens before any transaction opens.
 */
async function runSyncMetadata(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, client: JiraClient, cursor: JiraSyncCursor): Promise<JiraSyncCursor> {
  const ctx = ctxOf(migration);
  const previous = migration.discovery as unknown as JiraDiscovery;
  const meta = await discoverJiraMetadata(client, { projectKey: migration.jiraProjectKey, boardId: migration.jiraBoardId ?? undefined });
  const discovery: JiraDiscovery = {
    ...previous,
    myself: meta.myself,
    project: meta.project,
    boards: meta.boards,
    board: meta.board,
    sprints: mergeSprintLists(previous.sprints, meta.sprints),
    statuses: meta.statuses,
    issueTypes: meta.issueTypes,
    priorities: meta.priorities,
    fields: meta.fields,
  };

  return deps.withTenantAs(ctx, async (tx) => {
    const before = await namesOfProjectSetup(tx, migration.projectId);
    const targets = await listJiraMappingTargets(tx, migration.projectId, migration.boardId);
    const previousMapping = migration.mapping as unknown as JiraMigrationMapping;
    const mapping = mergeJiraMapping(previousMapping, suggestJiraMapping(discovery, targets), targets);
    const input = importInputFromDiscovery(discovery, mapping);
    const loadCtx = syncLoadCtxOf(migration, cursor.importRunId, discovery, mapping);

    // Created here, then the snapshots of what was created are taken, as a full run takes them at finalize.
    const created = await prepareJiraImport(tx, loadCtx, input);
    await recordCreatedSprintSnapshots(tx, created);
    const sprintStates = await syncImportedSprintStates(tx, ctx, migration.boardId, discovery.sprints);
    // Once more, now the sprint states have moved, so the prepared sprints carry them.
    const prepared = await prepareJiraImport(tx, loadCtx, input);
    const after = await namesOfProjectSetup(tx, migration.projectId);

    await saveJiraSyncMetadata(tx, migration.id, toJson(discovery), toJson(mapping));
    const notes = { ...cursor.notes };
    notes.newStatuses = [...notes.newStatuses, ...discovery.statuses.map((s) => s.name).filter((n) => after.statuses.has(n.toLowerCase()) && !before.statuses.has(n.toLowerCase()))];
    notes.newTypes = [...notes.newTypes, ...discovery.issueTypes.map((t) => t.name).filter((n) => after.types.has(n.toLowerCase()) && !before.types.has(n.toLowerCase()))];
    notes.newProperties = [...notes.newProperties, ...[...after.properties].filter(([key]) => !before.properties.has(key)).map(([, name]) => name)];
    const next: JiraSyncCursor = {
      ...cursor,
      phase: "changed",
      nextPageToken: null,
      pagesDone: 0,
      attemptsOnPage: 0,
      prepared,
      notes,
      counts: {
        ...cursor.counts,
        sprintsCreated: cursor.counts.sprintsCreated + created.counts.sprintsCreated,
        sprintsStarted: cursor.counts.sprintsStarted + sprintStates.sprintsStarted,
        sprintsCompleted: cursor.counts.sprintsCompleted + sprintStates.sprintsCompleted,
      },
    };
    await updateJiraMigrationCursor(tx, migration.id, toJson(next), toJson({ phase: "sync", done: next.issuesRead, total: null }));
    return next;
  });
}

/** Everyone a page's issues mention, by account id. */
function usersOfPage(issues: JiraIssue[]): Map<string, JiraUser> {
  const out = new Map<string, JiraUser>();
  const add = (u: JiraUser | null | undefined) => {
    if (u?.accountId && !out.has(u.accountId)) out.set(u.accountId, u);
  };
  for (const issue of issues) {
    add(issue.fields.reporter);
    add(issue.fields.assignee);
    add(issue.fields.creator);
    for (const c of issue.fields.comment?.comments ?? []) add(c.author);
    for (const w of issue.fields.worklog?.worklogs ?? []) add(w.author);
    for (const h of issue.changelog?.histories ?? []) add(h.author);
    for (const w of issue.watchersList ?? []) add(w);
    for (const a of issue.fields.attachment ?? []) add(a.author);
  }
  return out;
}

/**
 * The fields a page uses that the mapping doesn't have yet, with their usage and option values, in the discovery's
 * shape. Each usage is counted once per issue. Used by a sync to suggest mappings for fields JIRA added since.
 */
function fieldsOfPage(issues: JiraIssue[], discovery: JiraDiscovery): { usage: Record<string, number>; options: Record<string, { value: string; count: number }[]> } {
  const usage = new Map<string, number>();
  const options = new Map<string, Map<string, number>>();
  const shapes = new Map((discovery.fields ?? []).map((f) => [f.id, f]));
  for (const issue of issues) {
    for (const [fieldId, value] of Object.entries(issue.fields as unknown as Record<string, unknown>)) {
      if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
      usage.set(fieldId, (usage.get(fieldId) ?? 0) + 1);
      const shape = shapes.get(fieldId);
      if (!shape || !collectsOptions(shape)) continue;
      const counts = options.get(fieldId) ?? new Map<string, number>();
      for (const v of optionValuesOf(value)) counts.set(v, (counts.get(v) ?? 0) + 1);
      options.set(fieldId, counts);
    }
  }
  return {
    usage: Object.fromEntries(usage),
    options: Object.fromEntries([...options].map(([id, counts]) => [id, [...counts].map(([value, count]) => ({ value, count }))])),
  };
}

/**
 * Runs one changed-issues page: reads it, then (in one transaction) suggests mappings for any people or fields the
 * page brings that the mapping lacks, creates what that needs, and applies the page's issues to Kompast.
 * Returns true when this was the last page.
 */
async function runSyncChangedPage(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, client: JiraClient, cursor: JiraSyncCursor, tally: JiraTickTally): Promise<{ last: boolean; next: JiraSyncCursor }> {
  const ctx = ctxOf(migration);
  const timeZone = resolveTimeZone((migration.discovery as unknown as JiraDiscovery | null)?.myself?.timeZone);
  const since = new Date(new Date(migration.lastSyncedAt!).getTime() - SYNC_OVERLAP_MS);
  let page = await fetchJiraIssuePage(client, changedSinceJql(migration.jiraProjectKey, since, timeZone), {
    nextPageToken: cursor.nextPageToken ?? undefined,
    fields: "*all",
    expand: "changelog",
    maxResults: PAGE_SIZE,
  });
  const enriched = await enrichJiraIssues(client, page.issues);
  page = { ...page, issues: enriched.issues };

  return deps.withTenantAs(ctx, async (tx) => {
    const [row] = await tx.select({ discovery: schema.jiraMigration.discovery, mapping: schema.jiraMigration.mapping }).from(schema.jiraMigration).where(eq(schema.jiraMigration.id, migration.id));
    const discovery = row?.discovery as unknown as JiraDiscovery;
    let mapping = row?.mapping as unknown as JiraMigrationMapping;
    let prepared = cursor.prepared!;
    const notes = { ...cursor.notes };

    // People and fields the mapping doesn't know yet: suggested, then created by the prepare step.
    const knownAccounts = new Set(mapping.people.map((p) => p.accountId));
    const strangers = [...usersOfPage(page.issues).values()].filter((u) => !knownAccounts.has(u.accountId));
    const { usage, options } = fieldsOfPage(page.issues, discovery);
    const knownFields = new Set((mapping.fields ?? []).map((f) => f.jiraFieldId));
    const unknownUsed = Object.keys(usage).filter((id) => !knownFields.has(id) && (discovery.fields ?? []).some((f) => f.id === id));
    if (strangers.length > 0 || unknownUsed.length > 0) {
      const targets = await listJiraMappingTargets(tx, migration.projectId, migration.boardId);
      if (strangers.length > 0) {
        const suggested = suggestPeopleMapping(
          strangers.map((u) => ({ accountId: u.accountId, displayName: u.displayName, emailAddress: u.emailAddress ?? null })),
          targets.members,
        );
        mapping = { ...mapping, people: [...mapping.people, ...suggested] };
        notes.newPeople = [...notes.newPeople, ...strangers.map((u) => u.displayName)];
      }
      if (unknownUsed.length > 0) {
        for (const id of unknownUsed) {
          if (!discovery.fieldUsage) discovery.fieldUsage = {};
          discovery.fieldUsage[id] = usage[id]!;
          if (options[id]) discovery.fieldOptions = { ...(discovery.fieldOptions ?? {}), [id]: options[id]! };
        }
        const newFieldDiscovery: JiraDiscovery = { ...discovery, fieldUsage: Object.fromEntries(unknownUsed.map((id) => [id, usage[id]!])) };
        const suggestedFields = suggestFieldMappings(newFieldDiscovery, targets.properties ?? []).filter((f) => !knownFields.has(f.jiraFieldId));
        const claimed = new Set((mapping.fields ?? []).filter((f) => f.action === "core" && f.coreField).map((f) => f.coreField));
        const safe = suggestedFields.map((f) => (f.action === "core" && f.coreField && claimed.has(f.coreField) ? { jiraFieldId: f.jiraFieldId, jiraName: f.jiraName, action: "skip" as const } : f));
        mapping = { ...mapping, fields: [...(mapping.fields ?? []), ...safe] };
      }
      const beforeProps = await namesOfProjectSetup(tx, migration.projectId);
      await saveJiraSyncMetadata(tx, migration.id, toJson(discovery), toJson(mapping));
      prepared = await prepareJiraImport(tx, syncLoadCtxOf(migration, cursor.importRunId, discovery, mapping), importInputFromDiscovery(discovery, mapping));
      const afterProps = await namesOfProjectSetup(tx, migration.projectId);
      notes.newProperties = [...notes.newProperties, ...[...afterProps.properties].filter(([key]) => !beforeProps.properties.has(key)).map(([, name]) => name)];
    }

    const batch = await syncJiraIssueBatch(tx, page.issues, syncLoadCtxOf(migration, cursor.importRunId, discovery, mapping, prepared), prepared);
    const counts = { ...cursor.counts };
    for (const k of Object.keys(counts) as (keyof JiraSyncCounts)[]) counts[k] += batch.counts[k];
    const next: JiraSyncCursor = {
      ...cursor,
      nextPageToken: page.nextPageToken ?? null,
      pagesDone: cursor.pagesDone + 1,
      attemptsOnPage: 0,
      issuesRead: cursor.issuesRead + page.issues.length,
      deferredParents: [...cursor.deferredParents, ...batch.deferredParents],
      deferredLinks: [...cursor.deferredLinks, ...batch.deferredLinks],
      prepared,
      counts,
      errors: [...cursor.errors, ...batch.errors],
      notes: {
        ...notes,
        conflicts: [...notes.conflicts, ...batch.notes.conflicts],
        commentsMissingInJira: [...notes.commentsMissingInJira, ...batch.notes.commentsMissingInJira],
        worklogsMissingInJira: [...notes.worklogsMissingInJira, ...batch.notes.worklogsMissingInJira],
        linksMissingInJira: [...notes.linksMissingInJira, ...batch.notes.linksMissingInJira],
        attachmentsMissingInJira: [...notes.attachmentsMissingInJira, ...batch.notes.attachmentsMissingInJira],
        issueNotes: [...notes.issueNotes, ...batch.notes.issueNotes],
      },
    };
    tally.pages++;
    tally.issues += page.issues.length;
    if (!page.isLast) await updateJiraMigrationCursor(tx, migration.id, toJson(next), toJson({ phase: "sync", done: next.issuesRead, total: null }));
    return { last: page.isLast, next };
  });
}

/**
 * The keys phase: every key the project has, a page at a time. A key the project has but Kompast never imported is
 * ignored (a new issue is already in: the changed phase created it). When the last page is in, the imported keys
 * JIRA didn't list become the missing list.
 */
async function runSyncKeysPage(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, client: JiraClient, cursor: JiraSyncCursor): Promise<JiraSyncCursor> {
  const page = await fetchJiraIssuePage(client, projectKeysJql(migration.jiraProjectKey), {
    nextPageToken: cursor.nextPageToken ?? undefined,
    fields: "key",
    maxResults: SYNC_KEYS_PAGE_SIZE,
  });
  const keysSeen = [...cursor.keysSeen, ...page.issues.map((i) => i.key)];
  return deps.withTenantAs(ctxOf(migration), async (tx) => {
    let next: JiraSyncCursor = { ...cursor, keysSeen, nextPageToken: page.nextPageToken ?? null };
    if (page.isLast || !page.nextPageToken) {
      const seen = new Set(keysSeen);
      const imported = await tx
        .select({ sourceId: schema.externalRef.sourceId })
        .from(schema.externalRef)
        .innerJoin(schema.issue, eq(schema.issue.id, schema.externalRef.entityId))
        .where(
          and(
            eq(schema.externalRef.organizationId, migration.organizationId),
            eq(schema.externalRef.source, "jira"),
            eq(schema.externalRef.entityType, "issue"),
            eq(schema.issue.projectId, migration.projectId),
          ),
        );
      const missing = imported.map((r) => r.sourceId).filter((key) => !seen.has(key));
      next = { ...next, phase: "missing", nextPageToken: null, keysSeen: [], missing, missingIndex: 0 };
    }
    await updateJiraMigrationCursor(tx, migration.id, toJson(next), toJson({ phase: "sync", done: next.issuesRead, total: null }));
    return next;
  });
}

/**
 * The missing phase: one GET per imported key JIRA didn't list. 404 means the issue is gone (deleted), and a key
 * JIRA answers with a different one means it moved. Nothing is deleted or re-keyed: both are reported.
 */
async function runSyncMissingKey(client: JiraClient, projectKey: string, key: string, notes: JiraSyncNotes, errors: JiraLoadReport["errors"]): Promise<void> {
  try {
    const res = await client.get<{ key: string; fields?: { project?: { key?: string } } }>(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: "project" });
    if (res.key !== key || (res.fields?.project?.key && res.fields.project.key !== projectKey)) notes.movedInJira.push({ key, newKey: res.key });
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 404) notes.deletedInJira.push(key);
    else errors.push({ issueKey: key, error: `check in JIRA: ${errorMessage(err)}` });
  }
}

/**
 * Closes the sync: finalizes the deferred parents and links (and the mention targets), records the run, and either
 * sets lastSyncedAt (no attachment copies pending) or hands over to the attachments phase, which sets it when it ends.
 */
async function finishSync(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, cursor: JiraSyncCursor): Promise<void> {
  const ctx = ctxOf(migration);
  const discovery = migration.discovery as unknown as JiraDiscovery;
  const mapping = migration.mapping as unknown as JiraMigrationMapping;
  await deps.withTenantAs(ctx, async (tx) => {
    const prepared = cursor.prepared!;
    const fin = await finalizeJiraImport(tx, syncLoadCtxOf(migration, cursor.importRunId, discovery, mapping, prepared), prepared, {
      deferredParents: cursor.deferredParents,
      deferredLinks: cursor.deferredLinks,
    });
    const counts = {
      ...cursor.counts,
      linksCreated: cursor.counts.linksCreated + fin.counts.linksCreated,
      parentLinksResolved: fin.counts.parentLinksResolved,
      issueMentionsResolved: fin.counts.issueMentionsResolved,
      issueMentionsUnresolved: fin.counts.issueMentionsUnresolved,
    };
    const errors = [...cursor.errors, ...fin.errors];
    await completeImportRun(tx, cursor.importRunId, toJson(counts), toJson(errors), toJson(cursor.notes));

    const summary = await summarizeImportedAttachments(tx, migration.projectId);
    if (summary.counts.pending > 0) {
      const attachmentCursor: JiraMigrationAttachmentCursor = {
        importRunId: cursor.importRunId,
        phase: "attachments",
        lastSyncedAt: cursor.startedAt,
        attachmentsStored: 0,
        attachmentsFailed: 0,
        attachmentBytesStored: 0,
        inlineBlocksRewritten: 0,
        ...(cursor.then ? { then: cursor.then } : {}),
      };
      await updateJiraMigrationCursor(tx, migration.id, toJson(attachmentCursor), attachmentProgressOf(summary));
    } else if (cursor.then === "reconcile") {
      await chainReconcile(tx, migration, new Date(cursor.startedAt));
    } else {
      const finished: JiraSyncCursor = { ...cursor, phase: "finish", counts, errors };
      await updateJiraMigrationCursor(tx, migration.id, toJson(finished), toJson({ phase: "sync", done: cursor.issuesRead, total: null }));
      await markJiraMigrationSynced(tx, migration.id, new Date(cursor.startedAt));
    }
  });
}

/**
 * Runs one bounded slice of a catch-up sync: the metadata phase, then changed pages, the key list and the missing
 * checks, until the time budget is spent or the sync finishes. Every phase saves its place, so a restart resumes.
 */
async function runSync(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, tally: JiraTickTally): Promise<void> {
  const budgetMs = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const started = Date.now();
  const ctx = ctxOf(migration);
  if (!migration.lastSyncedAt) throw new Error("The migration has never finished a run, so there is nothing to sync from");
  const token = await requireToken(deps, migration.id);
  const client = clientFor(deps, migration, token);
  let cursor = readSyncCursor(migration.cursor);

  while (Date.now() - started <= budgetMs) {
    if (cursor.phase === "metadata") {
      cursor = await runSyncMetadata(deps, migration, client, cursor);
      continue;
    }
    if (cursor.phase === "changed") {
      try {
        const step = await runSyncChangedPage(deps, migration, client, cursor, tally);
        cursor = step.next;
        if (step.last) cursor = { ...cursor, phase: "keys", nextPageToken: null, keysSeen: [] };
        await renewJiraMigrationLease(deps.adminDb, migration.id, JIRA_MIGRATION_LEASE_MS);
      } catch (err) {
        const attemptsOnPage = cursor.attemptsOnPage + 1;
        if (attemptsOnPage >= MAX_PAGE_ATTEMPTS) {
          await recordFailure(deps, migration, errorMessage(err), cursor.importRunId);
          return;
        }
        cursor = { ...cursor, attemptsOnPage };
        await deps.withTenantAs(ctx, (tx) => updateJiraMigrationCursor(tx, migration.id, toJson(cursor), toJson({ phase: "sync", done: cursor.issuesRead, total: null })));
        return;
      }
      continue;
    }
    if (cursor.phase === "keys") {
      cursor = await runSyncKeysPage(deps, migration, client, cursor);
      if (cursor.phase === "keys") await renewJiraMigrationLease(deps.adminDb, migration.id, JIRA_MIGRATION_LEASE_MS);
      continue;
    }
    if (cursor.phase === "missing") {
      if (cursor.missingIndex >= cursor.missing.length) {
        cursor = { ...cursor, phase: "finish" };
        continue;
      }
      const key = cursor.missing[cursor.missingIndex]!;
      await runSyncMissingKey(client, migration.jiraProjectKey, key, cursor.notes, cursor.errors);
      cursor = { ...cursor, missingIndex: cursor.missingIndex + 1 };
      continue;
    }
    if (cursor.phase === "finish") {
      await finishSync(deps, migration, cursor);
      return;
    }
  }

  // Budget spent: keep the place. A missing-phase cursor keeps its notes too.
  await deps.withTenantAs(ctx, (tx) => updateJiraMigrationCursor(tx, migration.id, toJson(cursor), toJson({ phase: "sync", done: cursor.issuesRead, total: null })));
}

/**
 * Starts a sync for every synced migration whose auto-sync is due (packages/core's findDueJiraAutoSyncs), as its
 * creator, through the same startJiraMigrationRun a manual sync uses. A migration whose start fails is reported and
 * left as it is: it stays synced and is tried again on a later poll.
 */
export async function startDueJiraAutoSyncs(deps: Pick<JiraMigrationRunnerDeps, "adminDb" | "withTenantAs" | "now">): Promise<{ started: string[]; failed: { migrationId: string; error: string }[] }> {
  const now = deps.now ?? (() => new Date());
  const due = await findDueJiraAutoSyncs(deps.adminDb, now());
  const started: string[] = [];
  const failed: { migrationId: string; error: string }[] = [];
  for (const migration of due) {
    const ctx = ctxOf(migration);
    try {
      await deps.withTenantAs(ctx, (tx) => startJiraMigrationRun(tx, ctx, migration.id, { mode: "sync" }));
      started.push(migration.id);
    } catch (err) {
      failed.push({ migrationId: migration.id, error: errorMessage(err) });
    }
  }
  return { started, failed };
}

// ── Reconciliation ──────────────────────────────────────────────────────────

/** Watcher lists fetched per run at most. Past it, a watcher gap is reported as unverified rather than checked. */
const RECONCILE_WATCHER_CALL_CAP = 300;

/**
 * Saved resume state of a reconcile run. Changes no data. Phases: sprints (board sprints against the imported ones) →
 * issues (every JIRA issue, a page at a time, compared with Kompast) → missing (imported keys JIRA didn't list: one GET
 * each: 404 deleted, another key moved) → finish (the report is stored on the import run, and the migration goes back to synced).
 */
export interface JiraReconcileCursor {
  importRunId: string;
  mode: "reconcile";
  /** When the reconcile started. Informational. */
  startedAt: string;
  phase: "sprints" | "issues" | "missing" | "finish";
  nextPageToken: string | null;
  pagesDone: number;
  attemptsOnPage: number;
  issuesRead: number;
  counts: ReconcileCounts;
  differences: ReconcileDifference[];
  truncated: number;
  /** Keys an earlier run renumbered (its notes say so), read once at the sprints phase. */
  renumbered: string[];
  /** Every key JIRA's listing showed, collected by the issues phase. Cleared when the missing phase starts. */
  seenKeys: string[];
  /** Imported keys JIRA's listing did not show. Checked one by one in the missing phase. */
  missing: string[];
  missingIndex: number;
  /** Watcher lists fetched so far, against RECONCILE_WATCHER_CALL_CAP. */
  watcherCalls: number;
  errors: { issueKey: string; error: string }[];
}

function isReconcileCursor(raw: Json | null): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { mode?: unknown }).mode === "reconcile";
}

function readReconcileCursor(raw: Json | null): JiraReconcileCursor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The check is running but has no cursor");
  const c = raw as unknown as Partial<JiraReconcileCursor> & { importRunId: string; startedAt: string };
  return {
    importRunId: c.importRunId,
    mode: "reconcile",
    startedAt: c.startedAt,
    phase: c.phase ?? "sprints",
    nextPageToken: c.nextPageToken ?? null,
    pagesDone: c.pagesDone ?? 0,
    attemptsOnPage: c.attemptsOnPage ?? 0,
    issuesRead: c.issuesRead ?? 0,
    counts: c.counts ?? emptyReconcileCounts(),
    differences: c.differences ?? [],
    truncated: c.truncated ?? 0,
    renumbered: c.renumbered ?? [],
    seenKeys: c.seenKeys ?? [],
    missing: c.missing ?? [],
    missingIndex: c.missingIndex ?? 0,
    watcherCalls: c.watcherCalls ?? 0,
    errors: c.errors ?? [],
  };
}

function reconcileProgressOf(c: JiraReconcileCursor, total: number | null): Json {
  return toJson({ phase: "reconcile", done: c.issuesRead, total });
}

function reconcileEnvInputOf(migration: JiraMigrationPublic, discovery: JiraDiscovery, mapping: JiraMigrationMapping, renumbered: string[]) {
  return {
    organizationId: migration.organizationId,
    projectId: migration.projectId,
    boardId: migration.boardId,
    projectKey: migration.jiraProjectKey,
    lastSyncedAt: migration.lastSyncedAt ? new Date(migration.lastSyncedAt) : null,
    discovery,
    mapping,
    renumbered,
  };
}

/**
 * Runs one bounded slice of a reconcile: the sprints, the issue pages, the missing checks, then the finish, until the time
 * budget is spent. Each step saves its place. Reads both sides and writes nothing to Kompast's data.
 */
async function runReconcile(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, tally: JiraTickTally): Promise<void> {
  const budgetMs = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const started = Date.now();
  const ctx = ctxOf(migration);
  const discovery = migration.discovery as unknown as JiraDiscovery | null;
  const mapping = migration.mapping as unknown as JiraMigrationMapping | null;
  if (!discovery || !mapping) throw new Error("The migration has no discovery or mapping to check");
  const token = await requireToken(deps, migration.id);
  const client = clientFor(deps, migration, token);
  let cursor = readReconcileCursor(migration.cursor);
  const total = discovery.issueCount ?? null;
  const persist = (c: JiraReconcileCursor) =>
    deps.withTenantAs(ctx, (tx) => updateJiraMigrationCursor(tx, migration.id, toJson(c), reconcileProgressOf(c, total)));

  while (Date.now() - started <= budgetMs) {
    if (cursor.phase === "sprints") {
      cursor = await runReconcileSprints(deps, migration, client, cursor, discovery, mapping);
      await persist(cursor);
      continue;
    }
    if (cursor.phase === "issues") {
      try {
        cursor = await runReconcilePage(deps, migration, client, cursor, discovery, mapping, tally);
      } catch (err) {
        const attemptsOnPage = cursor.attemptsOnPage + 1;
        if (attemptsOnPage >= MAX_PAGE_ATTEMPTS) {
          await recordFailure(deps, migration, errorMessage(err), cursor.importRunId);
          return;
        }
        cursor = { ...cursor, attemptsOnPage };
        await persist(cursor);
        return;
      }
      await renewJiraMigrationLease(deps.adminDb, migration.id, JIRA_MIGRATION_LEASE_MS);
      continue;
    }
    if (cursor.phase === "missing") {
      if (cursor.missingIndex >= cursor.missing.length) {
        cursor = { ...cursor, phase: "finish" };
        await persist(cursor);
        continue;
      }
      cursor = await checkReconcileMissingKey(client, migration.jiraProjectKey, cursor.missing[cursor.missingIndex]!, cursor);
      await persist(cursor);
      continue;
    }
    if (cursor.phase === "finish") {
      await finishReconcile(deps, migration, cursor);
      return;
    }
  }
  await persist(cursor);
}

/** The sprints phase: JIRA's board sprints against the imported ones (state and name), plus the renumbered keys of earlier runs. */
async function runReconcileSprints(
  deps: JiraMigrationRunnerDeps,
  migration: JiraMigrationPublic,
  client: JiraClient,
  cursor: JiraReconcileCursor,
  discovery: JiraDiscovery,
  mapping: JiraMigrationMapping,
): Promise<JiraReconcileCursor> {
  const ctx = ctxOf(migration);
  const meta = await discoverJiraMetadata(client, { projectKey: migration.jiraProjectKey, boardId: migration.jiraBoardId ?? undefined });
  return deps.withTenantAs(ctx, async (tx) => {
    const runs = await listJiraMigrationRuns(tx, migration.id);
    const renumbered = renumberedKeysOf(runs.map((r) => ({ config: r.config, notes: r.notes })));
    const env = await loadReconcileEnv(tx, reconcileEnvInputOf(migration, discovery, mapping, renumbered));
    const log = new ReconcileLog(structuredClone(cursor.counts), [...cursor.differences], cursor.truncated);
    compareSprints(env, meta.sprints, log);
    return {
      ...cursor,
      phase: "issues",
      nextPageToken: null,
      pagesDone: 0,
      attemptsOnPage: 0,
      renumbered,
      counts: log.counts,
      differences: log.differences,
      truncated: log.truncated,
    };
  });
}

/**
 * One issue page: JIRA's page, Kompast's view of it in batched reads (one transaction), the watcher lists the page needs
 * (fetched outside any transaction, within the run's call cap), then the comparison, which writes nothing but the cursor.
 * On the last page, the imported keys the listing didn't show become the missing list.
 */
async function runReconcilePage(
  deps: JiraMigrationRunnerDeps,
  migration: JiraMigrationPublic,
  client: JiraClient,
  cursor: JiraReconcileCursor,
  discovery: JiraDiscovery,
  mapping: JiraMigrationMapping,
  tally: JiraTickTally,
): Promise<JiraReconcileCursor> {
  const ctx = ctxOf(migration);
  const page = await fetchJiraIssuePage(client, reconcileJql(migration.jiraProjectKey), {
    nextPageToken: cursor.nextPageToken ?? undefined,
    fields: reconcileFieldList(discovery, mapping),
    maxResults: PAGE_SIZE,
  });
  const envInput = reconcileEnvInputOf(migration, discovery, mapping, cursor.renumbered);
  const { env, snap } = await deps.withTenantAs(ctx, async (tx) => {
    const loaded = await loadReconcileEnv(tx, envInput);
    return { env: loaded, snap: await readReconcileSnapshot(tx, loaded, page.issues) };
  });

  const watchers: WatcherLists = new Map();
  const errors = [...cursor.errors];
  let watcherCalls = cursor.watcherCalls;
  for (const issue of page.issues) {
    const issueId = snap.issueIdByKey.get(issue.key);
    if (!issueId) continue;
    const jiraCount = issue.fields.watches?.watchCount ?? 0;
    const kompastCount = snap.watcherUserIdsByIssueId.get(issueId)?.size ?? 0;
    if (jiraCount <= kompastCount) continue;
    if (watcherCalls >= RECONCILE_WATCHER_CALL_CAP) break;
    watcherCalls++;
    try {
      const res = await client.get<{ watchers?: JiraUser[] }>(`/rest/api/3/issue/${encodeURIComponent(issue.key)}/watchers`);
      watchers.set(issue.key, res.watchers ?? []);
    } catch (err) {
      errors.push({ issueKey: issue.key, error: `watchers: ${errorMessage(err)}` });
    }
  }

  const log = new ReconcileLog(structuredClone(cursor.counts), [...cursor.differences], cursor.truncated);
  comparePage({ env, snap, issues: page.issues, watchers, log });
  const seenKeys = [...cursor.seenKeys, ...page.issues.map((i) => i.key)];
  tally.pages++;
  tally.issues += page.issues.length;

  const next: JiraReconcileCursor = {
    ...cursor,
    nextPageToken: page.nextPageToken ?? null,
    pagesDone: cursor.pagesDone + 1,
    attemptsOnPage: 0,
    issuesRead: cursor.issuesRead + page.issues.length,
    counts: log.counts,
    differences: log.differences,
    truncated: log.truncated,
    watcherCalls,
    errors,
    seenKeys,
  };

  return deps.withTenantAs(ctx, async (tx) => {
    let out = next;
    if (page.isLast) {
      const imported = await readImportedIssueKeys(tx, env);
      out = { ...next, phase: "missing", nextPageToken: null, seenKeys: [], missing: missingKeysOf(imported, new Set(seenKeys)), missingIndex: 0 };
    }
    await updateJiraMigrationCursor(tx, migration.id, toJson(out), reconcileProgressOf(out, discovery.issueCount ?? null));
    return out;
  });
}

/**
 * One imported key JIRA's listing didn't show: a GET by key. 404 is a deletion, another key or project is a move, and
 * anything else is a difference nothing explains. Counts one Kompast unit either way.
 */
async function checkReconcileMissingKey(client: JiraClient, projectKey: string, key: string, cursor: JiraReconcileCursor): Promise<JiraReconcileCursor> {
  const log = new ReconcileLog(structuredClone(cursor.counts), [...cursor.differences], cursor.truncated);
  log.tally("missingInJira", { kompast: 1 });
  try {
    const res = await client.get<{ key: string; fields?: { project?: { key?: string } } }>(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: "project" });
    if (res.key !== key || (res.fields?.project?.key && res.fields.project.key !== projectKey)) {
      log.difference({ category: "missingInJira", issueKey: key, jira: res.key, kompast: key, reason: "explained:moved" });
    } else {
      log.difference({
        category: "missingInJira",
        issueKey: key,
        jira: key,
        kompast: key,
        reason: "unexplained",
        detail: "JIRA still has this issue, but the project listing did not show it",
      });
    }
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 404) {
      log.difference({ category: "missingInJira", issueKey: key, jira: null, kompast: key, reason: "explained:deleted" });
    } else {
      log.difference({ category: "missingInJira", issueKey: key, jira: null, kompast: key, reason: "unexplained", detail: `check in JIRA: ${errorMessage(err)}` });
    }
  }
  return { ...cursor, counts: log.counts, differences: log.differences, truncated: log.truncated, missingIndex: cursor.missingIndex + 1 };
}

/**
 * Stores the report on the reconcile's import run (counts per category; notes with every difference, the truncated
 * count and the clean flag), and returns the migration to synced. lastSyncedAt is untouched: nothing was changed.
 */
async function finishReconcile(deps: JiraMigrationRunnerDeps, migration: JiraMigrationPublic, cursor: JiraReconcileCursor): Promise<void> {
  const ctx = ctxOf(migration);
  const notes = { differences: cursor.differences, truncated: cursor.truncated, clean: reconcileIsClean(cursor.counts) };
  await deps.withTenantAs(ctx, async (tx) => {
    await completeImportRun(tx, cursor.importRunId, toJson(cursor.counts), toJson(cursor.errors), toJson(notes));
    await markJiraMigrationIdle(tx, migration.id);
  });
}
