import { and, desc, eq, inArray, schema, sql, type Json } from "@kompast/db";
import type { AnyDb, Tx } from "./types";
import { id } from "./ids";
import { decryptSecret, encryptSecret } from "./crypto";
import { createImportRun, markImportRunRunning, pageImportTargetKey, requirePageImportTarget, type PageImportTarget } from "./import";
import type { AuthContext } from "./permissions";

/**
 * Notion API migration record. One row per connection to a Notion workspace,
 * owned by the member who connected it. See packages/db/src/schema/import.ts's
 * notionMigration doc comment.
 *
 * Tenant-scoped functions take `tx: Tx` and must be called inside
 * withAuthorizedTenant. RLS hides every row from anyone but its creator, so
 * a read by another member returns null, and every mutation below also
 * checks ctx.userId against the creator. The worker-facing functions take
 * `db: AnyDb` and are only called from apps/worker on the admin connection
 * (lease claim across every workspace, the same exception as the JIRA
 * migration's claim).
 */

/** How long a worker lease lasts before another process may claim the migration. */
export const NOTION_MIGRATION_LEASE_MS = 5 * 60_000;

export type NotionMigrationRow = typeof schema.notionMigration.$inferSelect;

/** A migration row with the encrypted token replaced by a boolean. Every read API returns this shape, never the ciphertext. */
export type NotionMigrationPublic = Omit<NotionMigrationRow, "tokenEncrypted"> & { hasToken: boolean };

function toPublic(row: NotionMigrationRow): NotionMigrationPublic {
  const { tokenEncrypted, ...rest } = row;
  return { ...rest, hasToken: tokenEncrypted !== null };
}

// ── Selection ───────────────────────────────────────────────────────────────

/** A root page the user picked, and the space its tree lands in. Children follow their root. */
export interface NotionSelectionRoot {
  notionId: string;
  title: string;
  target: PageImportTarget;
}

export interface NotionSelection {
  roots: NotionSelectionRoot[];
}

const MAX_NOTION_ID_LENGTH = 100;
const MAX_NOTION_TITLE_LENGTH = 500;
const MAX_TEAM_ID_LENGTH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTarget(raw: unknown, label: string): PageImportTarget {
  if (raw === "workspace" || raw === "private") return raw;
  if (isRecord(raw) && typeof raw.team === "string" && raw.team.length > 0 && raw.team.length <= MAX_TEAM_ID_LENGTH) return { team: raw.team };
  throw new Error(`${label}: choose Workspace, Private or a team space`);
}

/**
 * Checks a selection the user sent and returns a clean copy. This checks the
 * shape only. Whether the caller may import into each target is checked by
 * the callers, against the workspace (requireSelectionTargets).
 */
export function parseNotionSelection(raw: unknown): NotionSelection {
  if (!isRecord(raw) || !Array.isArray(raw.roots)) throw new Error("The selection must list the pages to import");
  const seen = new Set<string>();
  const roots = raw.roots.map((entry): NotionSelectionRoot => {
    if (!isRecord(entry)) throw new Error("A selected page is malformed");
    if (typeof entry.notionId !== "string" || entry.notionId.length === 0) throw new Error("Every selected page needs a Notion id");
    if (entry.notionId.length > MAX_NOTION_ID_LENGTH) throw new Error("A Notion id is too long");
    const title = typeof entry.title === "string" ? entry.title.slice(0, MAX_NOTION_TITLE_LENGTH) : "";
    const label = title || entry.notionId;
    if (seen.has(entry.notionId)) throw new Error(`${label}: the page is selected twice`);
    seen.add(entry.notionId);
    return { notionId: entry.notionId, title, target: parseTarget(entry.target, label) };
  });
  return { roots };
}

/** Every distinct target in the selection must pass requirePageImportTarget for this caller. */
async function requireSelectionTargets(tx: Tx, ctx: AuthContext, selection: NotionSelection): Promise<void> {
  const seen = new Map<string, PageImportTarget>();
  for (const root of selection.roots) seen.set(pageImportTargetKey(root.target, ctx.userId), root.target);
  for (const target of seen.values()) await requirePageImportTarget(tx, ctx, target);
}

// ── Record lifecycle (creator only) ─────────────────────────────────────────

const DISCOVERABLE_STATES = new Set(["draft", "ready", "done", "failed"]);
const RUNNING_OR_DISCOVERING = new Set(["discovering", "running"]);

async function loadOwnedRow(tx: Tx, ctx: AuthContext, migrationId: string): Promise<NotionMigrationRow> {
  const [row] = await tx.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
  if (!row || row.createdBy !== ctx.userId) throw new Error(`Notion migration ${migrationId} not found`);
  return row;
}

/** Whether a worker holds the row right now. An expired lease counts as free, which is what lets a stuck row be deleted. */
function leaseHeld(row: NotionMigrationRow, now = new Date()): boolean {
  return row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > now.getTime();
}

/**
 * Connects a Notion workspace: stores the integration token encrypted and
 * queues discovery (state "discovering"; the worker reads the page tree).
 * Any workspace member may connect one. The creator is ctx.userId.
 */
export async function createNotionMigration(tx: Tx, ctx: AuthContext, input: { token: string; workspaceName: string }): Promise<{ migrationId: string }> {
  const token = input.token.trim();
  if (!token) throw new Error("Enter the Notion integration token");
  const migrationId = id("notionmig");
  await tx.insert(schema.notionMigration).values({
    id: migrationId,
    organizationId: ctx.organizationId,
    createdBy: ctx.userId,
    workspaceName: input.workspaceName.trim().slice(0, 200),
    tokenEncrypted: encryptSecret(token),
    state: "discovering",
  });
  return { migrationId };
}

/** One migration, or null when it doesn't exist or the caller can't see it (RLS: creator only). */
export async function getNotionMigration(tx: Tx, migrationId: string): Promise<NotionMigrationPublic | null> {
  const [row] = await tx.select().from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
  return row ? toPublic(row) : null;
}

/** The migrations the caller created, newest first. RLS does the filtering: other members' rows are invisible to this query. */
export async function listNotionMigrations(tx: Tx): Promise<NotionMigrationPublic[]> {
  const rows = await tx.select().from(schema.notionMigration).orderBy(desc(schema.notionMigration.createdAt));
  return rows.map(toPublic);
}

/**
 * Replaces the token (and the workspace name) and queues a new discovery.
 * Refused while a run or a discovery is in progress: the worker holds the
 * old token then, and resetting the state would abandon its run.
 * The saved selection is kept.
 */
export async function updateNotionMigrationToken(tx: Tx, ctx: AuthContext, migrationId: string, input: { token: string; workspaceName: string }): Promise<void> {
  const row = await loadOwnedRow(tx, ctx, migrationId);
  if (RUNNING_OR_DISCOVERING.has(row.state)) throw new Error(`Cannot change the token while the migration is "${row.state}"`);
  const token = input.token.trim();
  if (!token) throw new Error("Enter the Notion integration token");
  await tx
    .update(schema.notionMigration)
    .set({
      tokenEncrypted: encryptSecret(token),
      tokenClearedAt: null,
      workspaceName: input.workspaceName.trim().slice(0, 200),
      state: "discovering",
      error: null,
      progress: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.notionMigration.id, migrationId));
}

/** Queues a fresh discovery of the same workspace. Needs the token still stored. */
export async function requestNotionDiscovery(tx: Tx, ctx: AuthContext, migrationId: string): Promise<void> {
  const row = await loadOwnedRow(tx, ctx, migrationId);
  if (!DISCOVERABLE_STATES.has(row.state)) throw new Error(`Cannot scan Notion while the migration is "${row.state}"`);
  if (!row.tokenEncrypted) throw new Error("This migration has no Notion token. Enter it again to continue");
  await tx
    .update(schema.notionMigration)
    .set({ state: "discovering", error: null, updatedAt: new Date() })
    .where(eq(schema.notionMigration.id, migrationId));
}

/**
 * Saves which root pages to import and where each goes. Only from "ready",
 * after discovery. Every distinct target must be one the caller may import
 * into (requirePageImportTarget), so a team the caller isn't on is refused here.
 */
export async function saveNotionSelection(tx: Tx, ctx: AuthContext, migrationId: string, raw: unknown): Promise<void> {
  const row = await loadOwnedRow(tx, ctx, migrationId);
  if (row.state !== "ready") throw new Error(`Choose pages only after discovery (this migration is "${row.state}")`);
  const selection = parseNotionSelection(raw);
  await requireSelectionTargets(tx, ctx, selection);
  await tx
    .update(schema.notionMigration)
    .set({ selection: selection as unknown as Json, updatedAt: new Date() })
    .where(eq(schema.notionMigration.id, migrationId));
}

/**
 * Starts a run: creates the import_run and moves the migration to "running".
 * The worker does the copying from there. Requires state "ready", a token,
 * and a non-empty selection. The targets are re-checked, since membership
 * may have changed since the selection was saved.
 */
export async function startNotionMigrationRun(tx: Tx, ctx: AuthContext, migrationId: string): Promise<{ importRunId: string }> {
  const row = await loadOwnedRow(tx, ctx, migrationId);
  if (row.state !== "ready") throw new Error(`Cannot start a Notion import while the migration is "${row.state}"`);
  if (!row.tokenEncrypted) throw new Error("This migration has no Notion token. Enter it again to continue");
  const selection = row.selection ? parseNotionSelection(row.selection) : { roots: [] };
  if (selection.roots.length === 0) throw new Error("Select at least one page to import");
  await requireSelectionTargets(tx, ctx, selection);

  const { importRunId } = await createImportRun(tx, {
    organizationId: row.organizationId,
    projectId: null,
    source: "notion",
    dryRun: false,
    config: { via: "api", migrationId },
    createdBy: ctx.userId,
  });
  await markImportRunRunning(tx, importRunId);
  await tx
    .update(schema.notionMigration)
    .set({ state: "running", importRunId, cursor: null, progress: null, error: null, updatedAt: new Date() })
    .where(eq(schema.notionMigration.id, migrationId));
  return { importRunId };
}

/**
 * Retries a failed migration. Goes back to "ready" when a discovery exists
 * (the same selection can run again), else to "discovering" (the failure
 * came before one finished). The token is kept either way.
 */
export async function retryNotionMigration(tx: Tx, ctx: AuthContext, migrationId: string): Promise<{ state: "ready" | "discovering" }> {
  const row = await loadOwnedRow(tx, ctx, migrationId);
  if (row.state !== "failed") throw new Error(`Only a failed migration can be retried (this one is "${row.state}")`);
  if (!row.tokenEncrypted) throw new Error("This migration has no Notion token. Enter it again to continue");
  const state = row.discovery ? "ready" : "discovering";
  await tx.update(schema.notionMigration).set({ state, error: null, updatedAt: new Date() }).where(eq(schema.notionMigration.id, migrationId));
  return { state };
}

/**
 * Deletes the record and its token. Imported pages stay where they are: this
 * only forgets the link back to Notion. Refused while a worker holds a lease
 * on it. An expired lease doesn't count, so a row a crashed worker left
 * behind can still be removed.
 */
export async function deleteNotionMigration(tx: Tx, ctx: AuthContext, migrationId: string): Promise<void> {
  const row = await loadOwnedRow(tx, ctx, migrationId);
  if (RUNNING_OR_DISCOVERING.has(row.state) && leaseHeld(row)) throw new Error(`Cannot delete the migration while it is "${row.state}"`);
  await tx.delete(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
}

// ── Worker side (admin connection) ──────────────────────────────────────────

/**
 * Leases up to 2 migrations that need work (discovering or running) whose
 * lease is free or expired. `FOR UPDATE SKIP LOCKED` keeps two worker
 * processes from claiming the same row. Admin connection only: this is a
 * system-wide scan across every workspace (packages/db/rls.sql).
 */
export async function claimNotionMigrations(db: AnyDb, leaseMs = NOTION_MIGRATION_LEASE_MS): Promise<NotionMigrationPublic[]> {
  const claimed = await db.execute<{ id: string }>(
    sql`update notion_migration
        set lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
            lease_owner = gen_random_uuid()::text
        where id in (
          select id from notion_migration
          where state in ('discovering', 'running')
            and (lease_expires_at is null or lease_expires_at < now())
          order by updated_at
          limit 2
          for update skip locked
        )
        returning id`,
  );
  const ids = claimed.map((r) => r.id);
  if (ids.length === 0) return [];
  const rows = await db.select().from(schema.notionMigration).where(inArray(schema.notionMigration.id, ids));
  return rows.map(toPublic);
}

/**
 * The lease condition for a write by the tick that holds `owner`. A null owner
 * (a row that wasn't claimed, as in tests that drive the runner directly) matches any row.
 */
function ownedBy(migrationId: string, owner: string | null) {
  return owner === null
    ? eq(schema.notionMigration.id, migrationId)
    : and(eq(schema.notionMigration.id, migrationId), eq(schema.notionMigration.leaseOwner, owner));
}

/** Extends the lease. False when `owner` no longer holds it: another tick claimed the row after the lease expired. */
export async function renewNotionMigrationLease(db: AnyDb, migrationId: string, owner: string | null, leaseMs = NOTION_MIGRATION_LEASE_MS): Promise<boolean> {
  const rows = await db
    .update(schema.notionMigration)
    .set({ leaseExpiresAt: sql`now() + (${leaseMs}::int * interval '1 millisecond')` })
    .where(ownedBy(migrationId, owner))
    .returning({ id: schema.notionMigration.id });
  return rows.length > 0;
}

/** Ends the lease, if `owner` still holds it. A tick that lost its lease leaves the newer tick's lease alone. */
export async function releaseNotionMigrationLease(db: AnyDb, migrationId: string, owner: string | null): Promise<void> {
  await db.update(schema.notionMigration).set({ leaseExpiresAt: null, leaseOwner: null }).where(ownedBy(migrationId, owner));
}

/** The decrypted Notion token, or null when none is stored. Admin connection only: the worker needs it to call Notion. */
export async function getNotionMigrationToken(db: AnyDb, migrationId: string): Promise<string | null> {
  const [row] = await db.select({ tokenEncrypted: schema.notionMigration.tokenEncrypted }).from(schema.notionMigration).where(eq(schema.notionMigration.id, migrationId));
  if (!row?.tokenEncrypted) return null;
  return decryptSecret(row.tokenEncrypted);
}

/** Stores the discovered page tree and the workspace's name, and moves the migration to "ready" for the user to pick pages. */
export async function saveNotionDiscovery(tx: Tx, migrationId: string, discovery: Json, workspaceName: string): Promise<void> {
  await tx
    .update(schema.notionMigration)
    .set({ state: "ready", discovery, workspaceName: workspaceName.trim().slice(0, 200), error: null, progress: null, updatedAt: new Date() })
    .where(eq(schema.notionMigration.id, migrationId));
}

/** Saves the runner's cursor. False when `owner` no longer holds the lease; nothing is written then. */
export async function updateNotionMigrationCursor(tx: Tx, migrationId: string, cursor: Json, progress: Json, owner: string | null = null): Promise<boolean> {
  const rows = await tx
    .update(schema.notionMigration)
    .set({ cursor, progress, updatedAt: new Date() })
    .where(ownedBy(migrationId, owner))
    .returning({ id: schema.notionMigration.id });
  return rows.length > 0;
}

/** Progress counts, written on the admin connection while a run or discovery is still going. Doesn't touch state or updated_at. */
export async function updateNotionMigrationProgress(db: AnyDb, migrationId: string, progress: Json): Promise<void> {
  await db.update(schema.notionMigration).set({ progress }).where(eq(schema.notionMigration.id, migrationId));
}

/**
 * A finished run: state "done". The token is kept, so the user can run the
 * migration again. Only deleteNotionMigration clears it. The resume cursor is
 * dropped, and the progress counts stay so the finished run can still be shown.
 */
export async function markNotionMigrationDone(tx: Tx, migrationId: string, owner: string | null = null): Promise<boolean> {
  const rows = await tx
    .update(schema.notionMigration)
    .set({ state: "done", cursor: null, error: null, updatedAt: new Date() })
    .where(ownedBy(migrationId, owner))
    .returning({ id: schema.notionMigration.id });
  return rows.length > 0;
}

/**
 * Typed AnyDb rather than Tx so the runner can record the failure on the
 * admin connection when the creator's own tenant transaction is what failed
 * (the creator left the workspace). The token is kept, so it can be retried.
 */
export async function markNotionMigrationFailed(db: AnyDb, migrationId: string, error: string, owner: string | null = null): Promise<boolean> {
  const rows = await db
    .update(schema.notionMigration)
    .set({ state: "failed", error, updatedAt: new Date() })
    .where(ownedBy(migrationId, owner))
    .returning({ id: schema.notionMigration.id });
  return rows.length > 0;
}
