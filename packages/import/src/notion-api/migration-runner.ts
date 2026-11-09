import { and, eq, isNull, schema, type Json } from "@kompast/db";
import {
  completeImportRun,
  createPage,
  enqueueReindex,
  failImportRun,
  getNotionMigrationToken,
  markNotionMigrationDone,
  markNotionMigrationFailed,
  pageImportTargetKey,
  parseNotionSelection,
  rankBetween,
  releaseNotionMigrationLease,
  renewNotionMigrationLease,
  resolveExternalRef,
  saveNotionDiscovery,
  syncPageMentions,
  updateNotionMigrationCursor,
  updateNotionMigrationProgress,
  upsertExternalRef,
  type AnyDb,
  type AuthContext,
  type NotionMigrationPublic,
  type PageImportTarget,
  type Tx,
} from "@kompast/core";
import { createNotionClient, NotionApiError, type NotionClient } from "./client";
import { discoverNotionWorkspace, MAX_DISCOVERY_RESULTS, type NotionNode } from "./discover";
import {
  databaseHasRowSubPages,
  indexDiscovery,
  MAX_NOTION_API_PAGES,
  NotionPlanLimitError,
  plannedItemOf,
  planRootItems,
  unindexedItem,
  type PlanIndex,
  type PlannedItem,
} from "./plan";
import {
  notionBlocksToBlockNote,
  databaseTable,
  propertiesTable,
  type BlockNode,
  type InlineDatabase,
  type NotionBlockWithChildren,
  type NotionConvertContext,
} from "./blocks-to-blocknote";
import type { NotionBlock, NotionDatabase, NotionPage, NotionUser } from "./types";
import { displayTitle, emojiOf, normalizeNotionId, richTextPlain, titleOfProperties } from "./util";

/**
 * Imports a Notion workspace through the Notion API, one bounded tick at a
 * time (the same shape as packages/import/src/jira/migration-runner.ts).
 *
 * Phases of a running migration, each saved in the migration's cursor so a
 * tick that stops (budget spent, a crash, a rate limit) resumes where it was:
 *   plan     walk each selected root's subtree (block children, databases' rows)
 *            and list its descendants, parents first. Nothing outside the
 *            selection is read. The discovery snapshot supplies titles and the
 *            children the blocks don't list.
 *   create   create the pages in batches, skipping ones an earlier run made
 *   users    list Notion users and match people to Kompast members by email
 *   content  for each created page, fetch its blocks, copy its files, convert,
 *            write its ydoc_state (only when none exists), and re-rank the
 *            children this run created into the order Notion shows them in
 * Then finalize: the import run is completed and the migration goes "done".
 *
 * Each unit runs on a copy of the cursor, which is only kept once the unit's
 * writes have committed, so a unit that throws leaves the saved state as it was.
 */

export interface NotionMigrationRunnerDeps {
  /** Admin connection: lease bookkeeping, the token read, and the fallback that records a failure when the creator's own transaction can't. */
  adminDb: AnyDb;
  /** Runs `fn` in a tenant-scoped transaction as `ctx.userId`. withAuthorizedTenant in production. */
  withTenantAs: <T>(ctx: AuthContext, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Defaults to the global fetch. Tests inject a fake Notion. */
  fetch?: typeof fetch;
  /** Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Stop starting new units after this long, so a tick stays inside the lease. The unit in hand finishes. Default 4 minutes. */
  tickBudgetMs?: number;
  /** BlockNote blocks → stored Yjs state. The worker passes @kompast/editor's blocksToYDocState. */
  blocksToYDocState: (blocks: unknown[]) => Uint8Array;
  /** Stores a copied file for a page and returns the URL the page points at. The worker passes @kompast/storage/page-assets' putPageAsset. */
  putPageAsset: (pageId: string, fileName: string, data: Uint8Array, contentType?: string) => Promise<string>;
}

export interface NotionRunCounts {
  planned: number;
  created: number;
  skipped: number;
  contentDone: number;
  assetsUploaded: number;
  filesNotImported: number;
  unknownBlocks: number;
}

export interface NotionQueueItem {
  id: string;
  kind: PlannedItem["kind"];
  title: string;
  dataSourceIds?: string[];
  properties?: { name: string; type: string }[];
}

/** Saved resume state. Lives in notion_migration.cursor as plain JSON; kept small, see the caps below. */
export interface NotionMigrationCursor {
  importRunId: string;
  phase: "plan" | "create" | "users" | "content";
  /** Consecutive failed attempts of the current unit. Reset by a unit that succeeds. */
  attempts: number;
  /** The planned pages, parents first. Null until the plan starts, and dropped once the pages are created. While planning, the items from `walk` on are not yet expanded. */
  items: PlannedItem[] | null;
  /** Plan phase: how many items have been expanded. */
  walk: number;
  createIndex: number;
  /** Notion page id → the Kompast page it became. Holds created and skipped pages alike; bounded by the plan's cap. */
  pages: Record<string, { pageId: string; title: string; icon: string | null; created: boolean }>;
  /** Notion user id → display name. */
  users: Record<string, string>;
  /** The pages this run created, in plan order, for the content phase. */
  queue: NotionQueueItem[];
  contentIndex: number;
  counts: NotionRunCounts;
  /** Errors for the run report, capped at ERROR_LIMIT. errorCount is the uncapped total. */
  errors: { page: string; error: string }[];
  errorCount: number;
}

interface UnitOutcome {
  cursor: NotionMigrationCursor;
  finished: boolean;
}

interface Env {
  deps: NotionMigrationRunnerDeps;
  migration: NotionMigrationPublic;
  client: NotionClient;
  ctx: AuthContext;
  lease: Lease;
}

/**
 * This tick's hold on the migration row. `owner` is the id the claim wrote into
 * lease_owner (null when the runner is driven without a claim, as in tests).
 * `lost` turns true once a renewal finds another tick holds the row.
 */
interface Lease {
  owner: string | null;
  lost: boolean;
}

/**
 * The tick no longer holds the lease: it ran past the expiry and another tick
 * claimed the row. It stops without writing anything, and the newer tick goes on
 * from the cursor it saved last.
 */
class NotionLeaseLostError extends Error {
  constructor() {
    super("Another worker tick took over this migration");
    this.name = "NotionLeaseLostError";
  }
}

/** Fails the run at once. Retrying can't help (the token is rejected, or the selection is too big). */
class NotionFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotionFatalError";
  }
}

const DEFAULT_TICK_BUDGET_MS = 4 * 60_000;
/** How often a running tick extends its lease, well inside NOTION_MIGRATION_LEASE_MS, so one slow page can't let it expire. */
const LEASE_HEARTBEAT_MS = 60_000;
const MAX_UNIT_ATTEMPTS = 3;
/** Pages written per transaction in the create phase. */
const CREATE_BATCH = 200;
const ERROR_LIMIT = 500;
const ERROR_TEXT_LIMIT = 500;
const MAX_BLOCK_DEPTH = 50;
/** Blocks whose children aren't fetched: sub-pages and sub-databases are imported as pages of their own. */
const NOT_RECURSED = new Set(["child_page", "child_database"]);
const FILE_BLOCK_TYPES = new Set(["image", "file", "pdf", "video", "audio"]);
/** An inline database with more rows than this shows only its link in the page body (its rows still import as pages). */
const MAX_INLINE_DATABASE_ROWS = 500;

function ctxOf(migration: NotionMigrationPublic): AuthContext {
  return { userId: migration.createdBy, organizationId: migration.organizationId };
}

function toJson(value: unknown): Json {
  return value as Json;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The message to record when an error should fail the run now, or null when it may be retried. */
function fatalMessage(err: unknown): string | null {
  if (err instanceof NotionFatalError || err instanceof NotionPlanLimitError) return err.message;
  if (err instanceof NotionApiError && err.status === 401) return "Notion rejected the token. Check the integration token, then try again.";
  return null;
}

function notionUrl(notionId: string): string {
  return `https://www.notion.so/${notionId.replace(/-/g, "")}`;
}

/** The external_ref key. Same shape as the zip loader's (packages/import/src/notion/load.ts), so the two importers dedupe against each other. */
function sourceIdFor(target: PageImportTarget, actorUserId: string, notionId: string): string {
  return `${pageImportTargetKey(target, actorUserId)}:${notionId}`;
}

/** The space a root page is created in. Its children inherit it from their parent. */
function rootSpace(target: PageImportTarget, actorUserId: string): { privateOwnerId: string | null } | { teamId: string } {
  if (typeof target === "object") return { teamId: target.team };
  return { privateOwnerId: target === "private" ? actorUserId : null };
}

function freshCursor(importRunId: string): NotionMigrationCursor {
  return {
    importRunId,
    phase: "plan",
    attempts: 0,
    items: null,
    walk: 0,
    createIndex: 0,
    pages: {},
    users: {},
    queue: [],
    contentIndex: 0,
    counts: { planned: 0, created: 0, skipped: 0, contentDone: 0, assetsUploaded: 0, filesNotImported: 0, unknownBlocks: 0 },
    errors: [],
    errorCount: 0,
  };
}

function readCursor(migration: NotionMigrationPublic): NotionMigrationCursor {
  const raw = migration.cursor as unknown as NotionMigrationCursor | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (!migration.importRunId) throw new Error("The migration is running but has no import run");
    return freshCursor(migration.importRunId);
  }
  return { ...freshCursor(raw.importRunId), ...raw };
}

function pushError(c: NotionMigrationCursor, page: string, error: string): void {
  c.errorCount++;
  if (c.errors.length < ERROR_LIMIT) c.errors.push({ page: page.slice(0, 200), error: error.slice(0, ERROR_TEXT_LIMIT) });
}

function progressOf(c: NotionMigrationCursor): Json {
  return toJson({
    phase: c.phase,
    planned: c.counts.planned,
    created: c.counts.created,
    skipped: c.counts.skipped,
    contentDone: c.counts.contentDone,
    contentTotal: c.queue.length,
    assetsUploaded: c.counts.assetsUploaded,
    unknownBlocks: c.counts.unknownBlocks,
    errors: c.errorCount,
  });
}

async function clientFor(deps: NotionMigrationRunnerDeps, migration: NotionMigrationPublic): Promise<NotionClient> {
  const token = await getNotionMigrationToken(deps.adminDb, migration.id);
  if (!token) throw new NotionFatalError("The Notion token for this migration is gone. Enter it again to continue.");
  return createNotionClient({ token, fetch: deps.fetch, sleep: deps.sleep });
}

/**
 * Records a failure against the migration (and its import run, if one exists).
 * Tries as the creator first. If that fails (for example, the creator left the
 * workspace), it falls back to the admin connection so the failure still lands.
 */
async function recordFailure(
  deps: NotionMigrationRunnerDeps,
  migration: NotionMigrationPublic,
  message: string,
  importRunId: string | null,
  lease: Lease,
): Promise<void> {
  if (lease.lost) return;
  const write = async (db: AnyDb) => {
    // A tick that lost its lease records nothing: the newer tick owns the run now.
    if (!(await markNotionMigrationFailed(db, migration.id, message, lease.owner))) return;
    if (importRunId) await failImportRun(db, importRunId, message);
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
export async function runNotionMigrationTick(deps: NotionMigrationRunnerDeps, migration: NotionMigrationPublic): Promise<void> {
  const lease: Lease = { owner: migration.leaseOwner ?? null, lost: false };
  // Keeps the lease alive while a unit is slow (a big page, Notion's rate limit, a retried request).
  const heartbeat = setInterval(() => {
    void renewLease(deps, migration.id, lease);
  }, LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    if (migration.state === "discovering") await runDiscovery(deps, migration, lease);
    else if (migration.state === "running") await runRun(deps, migration, lease);
  } catch (err) {
    if (err instanceof NotionLeaseLostError) return;
    const importRunId = migration.state === "running" ? migration.importRunId : null;
    await recordFailure(deps, migration, fatalMessage(err) ?? errorMessage(err), importRunId, lease).catch((recordErr) => {
      console.error(`[notion-migration] could not record failure for ${migration.id}:`, recordErr);
    });
  } finally {
    clearInterval(heartbeat);
    await releaseNotionMigrationLease(deps.adminDb, migration.id, lease.owner).catch((releaseErr) => {
      console.error(`[notion-migration] could not release lease for ${migration.id}:`, releaseErr);
    });
  }
}

/** Extends the lease. Marks it lost when another tick holds the row now. A failed renewal (a DB blip) changes nothing. */
async function renewLease(deps: NotionMigrationRunnerDeps, migrationId: string, lease: Lease): Promise<void> {
  if (lease.lost) return;
  try {
    if (!(await renewNotionMigrationLease(deps.adminDb, migrationId, lease.owner))) lease.lost = true;
  } catch {
    // Retried by the next heartbeat or unit.
  }
}

/** Saves the cursor in `tx`, or throws NotionLeaseLostError (rolling the unit back) when this tick no longer holds the lease. */
async function writeCursor(tx: Tx, env: Env, c: NotionMigrationCursor): Promise<void> {
  if (env.lease.lost || !(await updateNotionMigrationCursor(tx, env.migration.id, toJson(c), progressOf(c), env.lease.owner))) {
    env.lease.lost = true;
    throw new NotionLeaseLostError();
  }
}

async function runDiscovery(deps: NotionMigrationRunnerDeps, migration: NotionMigrationPublic, lease: Lease): Promise<void> {
  const client = await clientFor(deps, migration);
  const discovery = await discoverNotionWorkspace(client, {
    onProgress: async (scanned) => {
      await renewLease(deps, migration.id, lease);
      if (lease.lost) throw new NotionLeaseLostError();
      await updateNotionMigrationProgress(deps.adminDb, migration.id, toJson({ phase: "discovery", done: scanned, total: null })).catch(() => {});
    },
  });
  const discoveredAt = (deps.now ?? (() => new Date()))().toISOString();
  await deps.withTenantAs(ctxOf(migration), (tx) =>
    saveNotionDiscovery(tx, migration.id, toJson({ nodes: discovery.nodes, truncated: discovery.truncated, discoveredAt }), discovery.workspaceName),
  );
}

async function runRun(deps: NotionMigrationRunnerDeps, migration: NotionMigrationPublic, lease: Lease): Promise<void> {
  const importRunId = migration.importRunId;
  const started = Date.now();
  const budgetMs = deps.tickBudgetMs ?? DEFAULT_TICK_BUDGET_MS;
  let cursor: NotionMigrationCursor;
  let client: NotionClient;
  try {
    client = await clientFor(deps, migration);
    cursor = readCursor(migration);
  } catch (err) {
    await recordFailure(deps, migration, fatalMessage(err) ?? errorMessage(err), importRunId, lease);
    return;
  }
  const env: Env = { deps, migration, client, ctx: ctxOf(migration), lease };

  for (;;) {
    if (lease.lost) return;
    let outcome: UnitOutcome;
    try {
      outcome = await runUnit(env, cursor);
    } catch (err) {
      if (err instanceof NotionLeaseLostError) return;
      const fatal = fatalMessage(err);
      if (fatal) {
        await recordFailure(deps, migration, fatal, importRunId, lease);
        return;
      }
      const attempts = cursor.attempts + 1;
      if (attempts >= MAX_UNIT_ATTEMPTS) {
        await recordFailure(deps, migration, errorMessage(err), importRunId, lease);
        return;
      }
      // Keep the retry count so a permanently failing unit fails the run instead of looping forever.
      await deps.withTenantAs(env.ctx, (tx) => writeCursor(tx, env, { ...cursor, attempts })).catch((saveErr) => {
        if (!(saveErr instanceof NotionLeaseLostError)) console.error(`[notion-migration] could not save retry count for ${migration.id}:`, saveErr);
      });
      return;
    }
    cursor = outcome.cursor;
    await renewLease(deps, migration.id, lease);
    if (outcome.finished) return;
    if (Date.now() - started >= budgetMs) return;
  }
}

async function runUnit(env: Env, cursor: NotionMigrationCursor): Promise<UnitOutcome> {
  const next: NotionMigrationCursor = { ...structuredClone(cursor), attempts: 0 };
  switch (next.phase) {
    case "plan":
      return planUnit(env, next);
    case "create":
      return createUnit(env, next);
    case "users":
      return usersUnit(env, next);
    case "content":
      return contentUnit(env, next);
  }
}

async function saveCursor(env: Env, c: NotionMigrationCursor): Promise<void> {
  await env.deps.withTenantAs(env.ctx, (tx) => writeCursor(tx, env, c));
}

// ── plan ────────────────────────────────────────────────────────────────────

/** The discovery snapshot's nodes. A truncated discovery can't plan a selection reliably, so it fails the run (as the search-based plan did). */
function discoveredNodesOf(migration: NotionMigrationPublic): NotionNode[] {
  const raw = migration.discovery as unknown as { nodes?: unknown; truncated?: unknown } | null;
  if (!raw || !Array.isArray(raw.nodes)) {
    throw new NotionFatalError("The page list from discovery is missing. Discover the workspace again, then run the migration.");
  }
  if (raw.truncated === true) {
    throw new NotionFatalError(
      `The integration can reach more than ${MAX_DISCOVERY_RESULTS} pages and databases. Share fewer pages with the integration, then try again.`,
    );
  }
  return raw.nodes as NotionNode[];
}

/**
 * Runs `load`, and gives nothing when it fails for a reason other than a fatal
 * one. The content phase lists the same things for the same page and reports
 * the failure there, so the plan doesn't record it twice.
 */
async function listedOrNothing<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch (err) {
    if (fatalMessage(err)) throw err;
    return [];
  }
}

/**
 * A database's own title and data sources, read now (both can change after discovery).
 * Null when the read fails for a reason other than a fatal one: the caller keeps what it had.
 */
async function databaseFactsOf(client: NotionClient, databaseId: string): Promise<{ title: string; dataSourceIds: string[] } | null> {
  try {
    const db = await client.getDatabase(databaseId);
    return {
      title: richTextPlain(db.title).trim(),
      dataSourceIds: (db.data_sources ?? []).flatMap((ds) => normalizeNotionId(ds.id) ?? []),
    };
  } catch (err) {
    if (fatalMessage(err)) throw err;
    return null;
  }
}

/**
 * Sets a planned database's title and data sources from a fresh read. Title priority:
 * the database's own title, then the child_database block's (set by the caller), then
 * the discovered title (the data source's when the database had none), then "Untitled database".
 * The data sources fall back to the discovered ones when the read gives none.
 */
async function refreshDatabaseItem(client: NotionClient, item: PlannedItem): Promise<void> {
  const facts = await databaseFactsOf(client, item.id);
  if (facts?.title) item.title = facts.title;
  const fresh = facts?.dataSourceIds ?? [];
  item.dataSourceIds = fresh.length > 0 ? fresh : (item.dataSourceIds ?? []);
}

/** The child_page and child_database blocks of a page, in the order they read in the page (toggles and columns included). Trashed blocks are left out. */
async function subPageBlocks(client: NotionClient, pageId: string): Promise<NotionBlock[]> {
  const found: NotionBlock[] = [];
  const collect = (blocks: NotionBlockWithChildren[]) => {
    for (const block of blocks) {
      if (block.in_trash) continue;
      if (block.type === "child_page" || block.type === "child_database") found.push(block);
      collect(block.children);
    }
  };
  collect(await fetchBlockTree(client, pageId));
  return found;
}

function blockTitleOf(block: NotionBlock): string {
  const value = block[block.type] as { title?: unknown } | undefined;
  return typeof value?.title === "string" ? value.title : "";
}

/**
 * What one planned item leads to, added to `seen` as it goes:
 *   - a database: its rows, from each of its data sources
 *   - a row: its sub-pages, read from its body (only when its database has any discovered sub-pages)
 *   - a page: its sub-pages and sub-databases in document order, then the
 *     discovered children its blocks didn't list (oldest first)
 * Nothing outside the item's own subtree is read.
 */
async function expandItem(env: Env, index: PlanIndex, item: PlannedItem, seen: Set<string>): Promise<PlannedItem[]> {
  const { client } = env;
  const out: PlannedItem[] = [];
  const add = (child: PlannedItem) => {
    if (seen.has(child.id)) return;
    seen.add(child.id);
    out.push(child);
  };

  if (item.kind === "database") {
    await refreshDatabaseItem(client, item);
    for (const dataSourceId of item.dataSourceIds ?? []) {
      const rows = await listedOrNothing(() => allRows(client, dataSourceId));
      for (const row of rows) {
        const rowId = normalizeNotionId(row.id);
        if (!rowId || row.in_trash || row.archived) continue;
        add({
          id: rowId,
          kind: "row",
          parentId: item.id,
          title: displayTitle("row", titleOfProperties(row.properties)),
          icon: emojiOf(row.icon),
          target: item.target,
          createdTime: row.created_time ?? "",
        });
      }
    }
    return out;
  }

  if (item.kind === "row" && !(item.parentId && databaseHasRowSubPages(index, item.parentId))) return out;
  // Discovery lists every shared page, so a page it shows no children for has no sub-page the blocks could name that the walk would need. Leaf pages cost no read.
  if (item.kind === "page" && !index.children.has(item.id)) return out;

  const blocks = await listedOrNothing(() => subPageBlocks(client, item.id));
  for (const block of blocks) {
    const childId = normalizeNotionId(block.id);
    if (!childId) continue;
    const found = index.byId.get(childId);
    if (found) {
      const planned = plannedItemOf(found, item.id, item.target);
      // A database's block carries its title; it beats the discovered one (the database's own read can still replace it).
      const blockTitle = blockTitleOf(block).trim();
      if (block.type === "child_database" && blockTitle) planned.title = blockTitle;
      add(planned);
    } else add(unindexedItem(childId, block.type === "child_database" ? "database" : "page", blockTitleOf(block), item.id, item.target));
  }
  if (item.kind === "page") {
    for (const child of index.children.get(item.id) ?? []) add(plannedItemOf(child, item.id, item.target));
  }
  return out;
}

/**
 * Plans the selected roots and everything under them, a few items per tick.
 * Each item is expanded once (see expandItem); the expanded ones come before
 * the rest in `items`, so the cursor's `walk` index is the whole resume state.
 * Parents come before their children, and siblings in document order.
 */
async function planUnit(env: Env, c: NotionMigrationCursor): Promise<UnitOutcome> {
  const { deps, migration } = env;
  const started = Date.now();
  const budgetMs = deps.tickBudgetMs ?? DEFAULT_TICK_BUDGET_MS;
  const index = indexDiscovery(discoveredNodesOf(migration));

  if (c.items === null) {
    const selection = parseNotionSelection(migration.selection);
    const roots = selection.roots.flatMap((r) => {
      const notionId = normalizeNotionId(r.notionId);
      return notionId ? [{ notionId, target: r.target }] : [];
    });
    const planned = planRootItems(index, roots);
    for (const notionId of planned.missingRoots) {
      pushError(c, notionId, "Not found in the Notion workspace (deleted, trashed, or not shared with the integration)");
    }
    c.items = planned.items;
  }
  const items: PlannedItem[] = c.items ?? [];
  if (items.length > MAX_NOTION_API_PAGES) throw new NotionPlanLimitError(items.length);
  const seen = new Set(items.map((item) => item.id));

  while (c.walk < items.length) {
    const found = await expandItem(env, index, items[c.walk]!, seen);
    items.push(...found);
    c.walk++;
    if (items.length > MAX_NOTION_API_PAGES) throw new NotionPlanLimitError(items.length);
    await renewLease(deps, migration.id, env.lease);
    if (env.lease.lost) throw new NotionLeaseLostError();
    if (Date.now() - started >= budgetMs) break;
  }
  c.counts.planned = items.length;

  if (c.walk < items.length) {
    await saveCursor(env, c);
    return { cursor: c, finished: false };
  }
  c.phase = "create";
  await saveCursor(env, c);
  return { cursor: c, finished: false };
}

// ── create ──────────────────────────────────────────────────────────────────

async function isLivePage(tx: Tx, pageId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.page.id })
    .from(schema.page)
    .where(and(eq(schema.page.id, pageId), isNull(schema.page.archivedAt)));
  return !!row;
}

/** Creates one batch of planned pages in one transaction, with the cursor saved in the same commit. */
async function createUnit(env: Env, c: NotionMigrationCursor): Promise<UnitOutcome> {
  const { deps, migration, ctx } = env;
  const items = c.items ?? [];
  const end = Math.min(c.createIndex + CREATE_BATCH, items.length);

  await deps.withTenantAs(ctx, async (tx) => {
    for (let i = c.createIndex; i < end; i++) {
      await createItem(tx, env, c, items[i]!);
    }
    c.createIndex = end;
    if (end >= items.length) {
      c.queue = items
        .filter((item) => c.pages[item.id]?.created)
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          ...(item.dataSourceIds ? { dataSourceIds: item.dataSourceIds } : {}),
          ...(item.properties ? { properties: item.properties } : {}),
        }));
      c.contentIndex = 0;
      c.items = null;
      c.phase = "users";
    }
    await writeCursor(tx, env, c);
  });
  return { cursor: c, finished: false };
}

async function createItem(tx: Tx, env: Env, c: NotionMigrationCursor, item: PlannedItem): Promise<void> {
  const { migration, ctx } = env;
  const key = sourceIdFor(item.target, migration.createdBy, item.id);
  const title = displayTitle(item.kind, item.title);
  const ref = await resolveExternalRef(tx, migration.organizationId, "notion", key);
  if (ref && (await isLivePage(tx, ref.entityId))) {
    // Made by an earlier run into this same space, and still there. Left untouched.
    c.pages[item.id] = { pageId: ref.entityId, title, icon: item.icon, created: false };
    c.counts.skipped++;
    return;
  }
  const parent = item.parentId ? c.pages[item.parentId] : undefined;
  if (item.parentId && !parent) {
    pushError(c, item.title || item.id, "Its parent page was not imported");
    return;
  }
  try {
    const page = await tx.transaction(async (sp) => {
      const row = await createPage(sp, {
        organizationId: migration.organizationId,
        ...(parent ? { parentPageId: parent.pageId } : rootSpace(item.target, migration.createdBy)),
        title,
        icon: item.icon ?? undefined,
        actorUserId: migration.createdBy,
      });
      await upsertExternalRef(sp, {
        organizationId: migration.organizationId,
        source: "notion",
        sourceId: key,
        sourceUrl: notionUrl(item.id),
        entityType: "page",
        entityId: row.id,
        importRunId: migration.importRunId!,
      });
      return row;
    });
    c.pages[item.id] = { pageId: page.id, title, icon: item.icon, created: true };
    c.counts.created++;
  } catch (err) {
    pushError(c, item.title || item.id, errorMessage(err));
  }
}

// ── users ───────────────────────────────────────────────────────────────────

/** Lists the Notion users once. A person whose email matches a Kompast member is shown by that member's name. */
async function usersUnit(env: Env, c: NotionMigrationCursor): Promise<UnitOutcome> {
  const { client, deps, migration, ctx } = env;
  const users: NotionUser[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.listUsers(cursor);
    users.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  await deps.withTenantAs(ctx, async (tx) => {
    const members = await tx
      .select({ email: schema.user.email, name: schema.user.name })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(eq(schema.member.organizationId, migration.organizationId));
    const kompastName = new Map(members.map((m) => [m.email.toLowerCase(), m.name]));
    const map: Record<string, string> = {};
    for (const u of users) {
      if (u.type === "bot") continue;
      const id = normalizeNotionId(u.id);
      const email = u.person?.email?.toLowerCase();
      const name = (email && kompastName.get(email)) || u.name || "";
      if (id && name) map[id] = name;
    }
    c.users = map;
    c.phase = "content";
    await writeCursor(tx, env, c);
  });
  return { cursor: c, finished: false };
}

// ── content ─────────────────────────────────────────────────────────────────

/** Fetches a block and its children, recursively. A reference synced block gets its original's children. */
async function fetchBlockTree(client: NotionClient, parentId: string, depth = 0): Promise<NotionBlockWithChildren[]> {
  const out: NotionBlockWithChildren[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.listBlockChildren(parentId, cursor);
    for (const block of page.results) {
      out.push({ ...block, children: await childrenOf(client, block, depth) });
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return out;
}

async function childrenOf(client: NotionClient, block: NotionBlock, depth: number): Promise<NotionBlockWithChildren[]> {
  if (depth >= MAX_BLOCK_DEPTH) return [];
  if (block.type === "synced_block") {
    const original = (block.synced_block as { synced_from?: { block_id?: string } | null } | undefined)?.synced_from?.block_id;
    const originalId = normalizeNotionId(original);
    if (originalId) return fetchBlockTree(client, originalId, depth + 1);
  }
  if (!block.has_children || NOT_RECURSED.has(block.type)) return [];
  return fetchBlockTree(client, block.id, depth + 1);
}

function walkBlocks(blocks: NotionBlockWithChildren[], visit: (block: NotionBlockWithChildren) => void): void {
  for (const block of blocks) {
    visit(block);
    walkBlocks(block.children, visit);
  }
}

/**
 * The Notion ids of a page's sub-pages and sub-databases, in the order they
 * read in the page (toggles and columns included). A child_page block's id is
 * its page's id, and a child_database block's id is its database's id.
 */
function subPageOrder(tree: NotionBlockWithChildren[]): string[] {
  const ids: string[] = [];
  walkBlocks(tree, (block) => {
    if (block.type !== "child_page" && block.type !== "child_database") return;
    const id = normalizeNotionId(block.id);
    if (id) ids.push(id);
  });
  return ids;
}

/**
 * Re-ranks the children this run created under a Kompast page into the order
 * `childOrder` gives (Notion's order). Children the run didn't create (skipped,
 * pre-existing) keep their ranks. The created ones sort after them, by
 * `childOrder`; a created child not found there keeps its own relative order,
 * after the ones that were found. Ranks are generated in sequence with
 * rankBetween, so none collides with a kept sibling's.
 */
async function reorderCreatedChildren(tx: Tx, c: NotionMigrationCursor, pageId: string, childOrder: string[]): Promise<void> {
  if (childOrder.length === 0) return;
  const children = await tx.select({ id: schema.page.id, rank: schema.page.rank }).from(schema.page).where(eq(schema.page.parentPageId, pageId));
  if (children.length === 0) return;

  const createdNotionIdOf = new Map<string, string>();
  for (const [notionId, ref] of Object.entries(c.pages)) if (ref.created) createdNotionIdOf.set(ref.pageId, notionId);

  const position = new Map<string, number>();
  childOrder.forEach((notionId, i) => {
    if (!position.has(notionId)) position.set(notionId, i);
  });

  const created: { id: string; rank: string; position: number }[] = [];
  const keptRanks: string[] = [];
  for (const child of children) {
    const notionId = createdNotionIdOf.get(child.id);
    if (notionId === undefined) keptRanks.push(child.rank);
    else created.push({ id: child.id, rank: child.rank, position: position.get(notionId) ?? Number.MAX_SAFE_INTEGER });
  }
  if (created.length === 0) return;

  created.sort((a, b) => a.position - b.position || (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  let prev: string | null = keptRanks.reduce<string | null>((max, r) => (max === null || r > max ? r : max), null);
  for (const child of created) {
    const rank = rankBetween(prev, null);
    if (rank !== child.rank) await tx.update(schema.page).set({ rank }).where(eq(schema.page.id, child.id));
    prev = rank;
  }
}

async function allRows(client: NotionClient, dataSourceId: string): Promise<NotionPage[]> {
  const rows: NotionPage[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.queryDataSource(dataSourceId, cursor);
    rows.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return rows;
}

/** A discovered node by its Notion id, from the discovery snapshot (its schema, for an inline database). */
function discoveredNodeOf(migration: NotionMigrationPublic, notionId: string): NotionNode | undefined {
  const raw = migration.discovery as unknown as { nodes?: unknown } | null;
  const nodes = raw && Array.isArray(raw.nodes) ? (raw.nodes as NotionNode[]) : [];
  return nodes.find((n) => n.id === notionId);
}

/**
 * An inline database's table content: its rows (not trashed, from each data
 * source, in the order they come back), with the schema the discovery snapshot
 * has. Null when the database isn't inline, can't be read, or has more than
 * MAX_INLINE_DATABASE_ROWS rows. Those render as a link only.
 */
async function inlineDatabaseOf(env: Env, databaseId: string): Promise<InlineDatabase | null> {
  const { client, migration } = env;
  let db: NotionDatabase;
  try {
    db = await client.getDatabase(databaseId);
  } catch (err) {
    if (fatalMessage(err)) throw err;
    return null;
  }
  if (db.is_inline !== true) return null;
  const rows: NotionPage[] = [];
  try {
    for (const ds of db.data_sources ?? []) {
      const dataSourceId = normalizeNotionId(ds.id);
      if (!dataSourceId) continue;
      let cursor: string | null = null;
      do {
        const page = await client.queryDataSource(dataSourceId, cursor);
        for (const row of page.results) {
          if (row.in_trash || row.archived) continue;
          rows.push(row);
          if (rows.length > MAX_INLINE_DATABASE_ROWS) return null;
        }
        cursor = page.has_more ? page.next_cursor : null;
      } while (cursor);
    }
  } catch (err) {
    if (fatalMessage(err)) throw err;
    return null;
  }
  return { properties: discoveredNodeOf(migration, databaseId)?.properties ?? [], rows };
}

/** Reads the inline databases a page's body shows (blocks in the trash are left out), into `into`, keyed by Notion id. */
async function readInlineDatabases(env: Env, tree: NotionBlockWithChildren[], into: Map<string, InlineDatabase>): Promise<void> {
  const ids: string[] = [];
  const collect = (blocks: NotionBlockWithChildren[]) => {
    for (const block of blocks) {
      if (block.in_trash) continue;
      if (block.type === "child_database") {
        const id = normalizeNotionId(block.id);
        if (id && !ids.includes(id)) ids.push(id);
      }
      collect(block.children);
    }
  };
  collect(tree);
  for (const id of ids) {
    const table = await inlineDatabaseOf(env, id);
    if (table) into.set(id, table);
  }
}

interface PreparedContent {
  state: Uint8Array;
  mentioned: string[];
  unknownBlocks: number;
  filesNotImported: number;
  assetsUploaded: number;
  errors: { page: string; error: string }[];
  /** Notion ids of the page's children (sub-pages, or a database's rows), in Notion's order. */
  childOrder: string[];
}

/**
 * Everything a page needs before its transaction: the source (blocks, or a
 * database's rows, or a row's properties), the copied files, and the converted
 * Yjs state. No database writes happen here.
 */
async function prepareContent(env: Env, c: NotionMigrationCursor, item: NotionQueueItem, pageId: string): Promise<PreparedContent> {
  const { client, deps } = env;
  const errors: { page: string; error: string }[] = [];
  const mentioned = new Set<string>();
  const assets = new Map<string, { url: string; name: string }>();
  const inlineDatabases = new Map<string, InlineDatabase>();
  let assetsUploaded = 0;

  const conv: NotionConvertContext = {
    inlineDatabase: (notionId) => inlineDatabases.get(notionId) ?? null,
    resolvePage: (notionId) => {
      const ref = c.pages[notionId];
      if (!ref) return null;
      mentioned.add(ref.pageId);
      return { pageId: ref.pageId, title: ref.title, icon: ref.icon };
    },
    userName: (notionUserId, fallbackName) => {
      const known = notionUserId ? c.users[normalizeNotionId(notionUserId) ?? ""] : undefined;
      return known || fallbackName?.trim() || "Notion user";
    },
    assetUrl: (blockId) => assets.get(normalizeNotionId(blockId) ?? blockId) ?? null,
  };

  const leading: BlockNode[] = [];
  let tree: NotionBlockWithChildren[] = [];
  let childOrder: string[] = [];
  if (item.kind === "database") {
    const rows: NotionPage[] = [];
    for (const dataSourceId of item.dataSourceIds ?? []) rows.push(...(await allRows(client, dataSourceId)));
    // A database's rows are its children, in the order the data source returns them.
    childOrder = rows.flatMap((row) => normalizeNotionId(row.id) ?? []);
    leading.push(databaseTable(item.properties ?? [], rows, conv));
  } else {
    if (item.kind === "row") {
      const row = await client.getPage(item.id);
      const table = propertiesTable(row.properties, conv);
      if (table) leading.push(table);
    }
    tree = await fetchBlockTree(client, item.id);
    childOrder = subPageOrder(tree);
    // The rows of inline databases, read before conversion (the converter stays pure). Their row pages are created in the create phase.
    await readInlineDatabases(env, tree, inlineDatabases);
    // Downloaded now: Notion's file URLs expire after about an hour.
    const files: NotionBlockWithChildren[] = [];
    walkBlocks(tree, (block) => {
      if (FILE_BLOCK_TYPES.has(block.type)) files.push(block);
    });
    for (const block of files) {
      const value = (block[block.type] ?? {}) as { type?: string; name?: string; file?: { url?: string } };
      if (value.type !== "file" || !value.file?.url) continue;
      const name = value.name || decodeLastSegment(value.file.url) || block.type;
      try {
        const bytes = await client.download(value.file.url);
        const url = await deps.putPageAsset(pageId, name, bytes);
        assets.set(normalizeNotionId(block.id) ?? block.id, { url, name });
        assetsUploaded++;
      } catch (err) {
        if (fatalMessage(err)) throw err;
        errors.push({ page: item.title || item.id, error: `File not imported: ${name} (${errorMessage(err)})` });
      }
    }
  }

  const converted = notionBlocksToBlockNote(tree, conv);
  let blocks = [...leading, ...converted.blocks];
  if (blocks.length === 0) blocks = [{ type: "paragraph", props: {}, content: [], children: [] }];
  return {
    state: deps.blocksToYDocState(blocks),
    mentioned: [...mentioned],
    unknownBlocks: converted.stats.unknownBlocks,
    filesNotImported: converted.stats.filesNotImported,
    assetsUploaded,
    errors,
    childOrder,
  };
}

function decodeLastSegment(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One created page. Its content is prepared outside any transaction, then
 * written with the cursor in one commit. A page that fails leaves an error
 * entry and stays empty. The run carries on.
 */
async function contentUnit(env: Env, c: NotionMigrationCursor): Promise<UnitOutcome> {
  if (c.contentIndex >= c.queue.length) return finalize(env, c);
  const { deps, migration, ctx } = env;
  const item = c.queue[c.contentIndex]!;
  const page = c.pages[item.id];
  if (!page) {
    c.contentIndex++;
    c.counts.contentDone++;
    await saveCursor(env, c);
    return { cursor: c, finished: false };
  }

  let prepared: PreparedContent | null = null;
  try {
    prepared = await prepareContent(env, c, item, page.pageId);
  } catch (err) {
    if (fatalMessage(err)) throw err;
    pushError(c, item.title || item.id, `Content not imported: ${errorMessage(err)}`);
  }

  await deps.withTenantAs(ctx, async (tx) => {
    if (prepared) {
      c.counts.assetsUploaded += prepared.assetsUploaded;
      c.counts.filesNotImported += prepared.filesNotImported;
      c.counts.unknownBlocks += prepared.unknownBlocks;
      for (const e of prepared.errors) pushError(c, e.page, e.error);
      try {
        await tx.transaction(async (sp) => {
          // The children this run created follow Notion's order. Same commit as the content.
          await reorderCreatedChildren(sp, c, page.pageId, prepared!.childOrder);

          // ydoc_state exists only if someone opened or saved the page in Kompast during the migration. Don't overwrite their edits.
          const written = await sp
            .insert(schema.ydocState)
            .values({ pageId: page.pageId, state: Buffer.from(prepared!.state) })
            .onConflictDoNothing({ target: schema.ydocState.pageId })
            .returning({ pageId: schema.ydocState.pageId });
          if (written.length === 0) {
            pushError(c, item.title || item.id, "Edited in Kompast during the migration; content not imported");
            return;
          }
          await enqueueReindex(sp, { organizationId: migration.organizationId, entityType: "page", entityId: page.pageId });
          await syncPageMentions(
            sp,
            migration.organizationId,
            page.pageId,
            prepared!.mentioned.map((id) => ({ type: "page" as const, id })),
          );
        });
      } catch (err) {
        pushError(c, item.title || item.id, `Content not imported: ${errorMessage(err)}`);
      }
    }
    c.contentIndex++;
    c.counts.contentDone++;
    await writeCursor(tx, env, c);
  });
  return { cursor: c, finished: false };
}

/** Completes the import run and marks the migration done. Its resume cursor is dropped by markNotionMigrationDone. */
async function finalize(env: Env, c: NotionMigrationCursor): Promise<UnitOutcome> {
  const { deps, migration, ctx } = env;
  const counts = { ...c.counts, errorCount: c.errorCount };
  await deps.withTenantAs(ctx, async (tx) => {
    await completeImportRun(tx, c.importRunId, toJson(counts), toJson(c.errors));
    // A tick that lost its lease must not complete the run: throwing rolls back completeImportRun too.
    if (env.lease.lost || !(await markNotionMigrationDone(tx, migration.id, env.lease.owner))) {
      env.lease.lost = true;
      throw new NotionLeaseLostError();
    }
  });
  return { cursor: c, finished: true };
}
