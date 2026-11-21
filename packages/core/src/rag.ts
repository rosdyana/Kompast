import { and, asc, count, countDistinct, desc, eq, inArray, sql, cosineDistance, schema, type Json, type SQL } from "@kompast/db";
import { createAiClient, createEmbeddingClient, resolveModelName, testEmbeddingConnection, type AiCredentials, type AiMessage, type AiToolDefinition, type EmbeddingCredentials, type EmbeddingTestResult } from "@kompast/ai";
import type { Tx, AnyDb } from "./types";
import { id } from "./ids";
import { withAuthorizedTenant, type AuthContext } from "./permissions";
import {
  assertKeyNotRetargeted,
  embeddingCredentialsFromRow,
  getAiCredentials,
  getEmbeddingCredentials,
  getSystemSettingsRow,
  redactSecret,
  type UpdateEmbeddingSettingsInput,
} from "./settings";
import { AiNotConfiguredError, recordAiUsage } from "./ai";
import { NotFoundError, UserFacingError } from "./errors";
import { enrichCandidates, type EnrichedCandidate, type RagEnrichment } from "./rag-enrich";
import { askTools, runAskTool, ASK_WRITE_TOOL_NAMES, proposeAskWrite, type AskProposal } from "./ask-tools";
import { toPlainText } from "./rich-text";
import { pageStateToPlainText } from "./ydoc-text";

export type RagEntityType = "issue" | "comment" | "page";

const MAX_CHUNK_CHARS = 1000;

/**
 * Paragraph-aware, not sentence-aware — splits on blank lines and greedily
 * merges paragraphs up to MAX_CHUNK_CHARS. A single paragraph longer than
 * that is kept whole rather than cut mid-sentence (a slightly-oversized
 * chunk beats a chunk that stops mid-thought). Used for issue, comment and
 * page text alike. Pages are much longer and richer than issues, so they
 * may still need a smarter splitter if retrieval quality suffers.
 */
export function chunkText(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Chunks + embeds `text`, replacing any existing chunks for this entity
 * wholesale (never merged/diffed) — simplest correct behavior when
 * content shrinks (fewer chunks) or grows (more chunks). Silently does
 * nothing if embeddings aren't configured/enabled yet — this runs from a
 * background worker job where "not configured" is a normal, expected
 * state until an admin sets it up in /settings, not an error to surface.
 */
export async function indexEntity(tx: Tx, input: { organizationId: string; entityType: RagEntityType; entityId: string; text: string }) {
  await tx.delete(schema.embedding).where(and(eq(schema.embedding.entityType, input.entityType), eq(schema.embedding.entityId, input.entityId)));

  const chunks = chunkText(input.text);
  if (chunks.length === 0) return;

  const creds = await getEmbeddingCredentials(tx);
  if (!creds) return;

  const client = createEmbeddingClient(creds, { dimensions: schema.EMBEDDING_DIMENSIONS });
  const vectors = await client.embed(chunks);
  // Checked here rather than left to Postgres: a wrong-size vector otherwise surfaces only as drizzle's opaque "Failed query: insert into embedding …" with the real reason buried in err.cause.
  if (vectors.length !== chunks.length) {
    throw new Error(`Embedding provider returned ${vectors.length} vectors for ${chunks.length} chunks`);
  }
  const badDims = vectors.find((v) => v.length !== schema.EMBEDDING_DIMENSIONS);
  if (badDims) {
    throw new Error(
      `Embedding model returned ${badDims.length}-dimensional vectors; Kompast stores ${schema.EMBEDDING_DIMENSIONS} — configure a ${schema.EMBEDDING_DIMENSIONS}-dimension model (e.g. text-embedding-3-small), or a text-embedding-3 model/deployment whose name contains "text-embedding-3", in /settings → Embedding, then re-index`,
    );
  }

  await tx.insert(schema.embedding).values(
    chunks.map((content, i) => ({
      id: id("emb"),
      organizationId: input.organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      chunkIndex: i,
      content,
      vector: vectors[i]!,
    })),
  );
}

// enqueueReindex lives in rag-queue.ts (no @kompast/ai dependency, so apps/collab can import it). Re-exported here so existing imports keep working.
export { enqueueReindex, type EnqueueReindexInput } from "./rag-queue";

/** A reindex task left "processing" longer than this was abandoned by a dead worker and is claimed again. */
export const REINDEX_CLAIM_STALE_MINUTES = 10;
/** Indexing attempts before a reindex task fails for good. Backoff doubles from 2 minutes. */
export const MAX_REINDEX_ATTEMPTS = 5;
/**
 * When a task that failed an attempt may be claimed again: its last attempt plus a backoff
 * that doubles from 2 minutes (capped at 64). Unqualified column names — only for queries
 * over embedding_index_queue alone.
 */
const REINDEX_RETRY_AT = sql`(claimed_at + make_interval(mins => (2 ^ least(attempts, 6))::int))`;
/** A pending task counts as ready (claimable now) when it never failed, or its retry backoff has passed. */
const REINDEX_READY = sql`(attempts = 0 or claimed_at is null or ${REINDEX_RETRY_AT} <= now())`;
/**
 * The worker polls every 10 s, so a task that has been ready this long with no claim in this
 * workspace for as long means the worker is down (or busy with another workspace's backlog).
 */
export const REINDEX_STALL_SECONDS = 120;

/**
 * System-wide scan across every workspace's queue — same admin-connection exception as claimPendingEmails/claimPendingAutomationEvents (see rls.sql).
 * Also reclaims tasks whose "processing" claim went stale, and honours retry backoff after a failed attempt.
 */
export async function claimPendingReindexTasks(db: AnyDb, limit = 10) {
  const claimed = await db.execute<{ id: string }>(
    sql`update embedding_index_queue set status = 'processing', claimed_at = now()
        where id in (
          select id from embedding_index_queue
          where (status = 'pending' and ${REINDEX_READY})
             or (status = 'processing' and claimed_at < now() - make_interval(mins => ${REINDEX_CLAIM_STALE_MINUTES}))
          order by created_at limit ${limit} for update skip locked
        )
        returning id`,
  );
  const ids = claimed.map((r) => r.id);
  if (ids.length === 0) return [];
  return db.select().from(schema.embeddingIndexQueue).where(inArray(schema.embeddingIndexQueue.id, ids));
}

export async function markReindexTaskProcessed(db: AnyDb, taskId: string) {
  await db.update(schema.embeddingIndexQueue).set({ status: "processed" }).where(eq(schema.embeddingIndexQueue.id, taskId));
}

export async function markReindexTaskFailed(db: AnyDb, taskId: string, error: string) {
  await db.update(schema.embeddingIndexQueue).set({ status: "failed", error }).where(eq(schema.embeddingIndexQueue.id, taskId));
}

/**
 * Records one failed indexing attempt. The task goes back to "pending" (retried
 * after a backoff, see claimPendingReindexTasks) until MAX_REINDEX_ATTEMPTS is
 * reached, then fails for good. Returns the resulting status.
 */
export async function recordReindexFailure(db: AnyDb, taskId: string, error: string): Promise<"pending" | "failed"> {
  const rows = await db.execute<{ status: "pending" | "failed" }>(
    sql`update embedding_index_queue
        set attempts = attempts + 1,
            error = ${error},
            claimed_at = now(),
            status = case when attempts + 1 >= ${MAX_REINDEX_ATTEMPTS} then 'failed' else 'pending' end
        where id = ${taskId}
        returning status`,
  );
  return rows[0]?.status ?? "failed";
}

/**
 * Fetches CURRENT content fresh (never from the queue payload — avoids
 * embedding stale text if several edits land before this task is
 * processed) and dispatches to indexEntity. A page's text is its title plus
 * its stored Yjs body converted to plain text (pageStateToPlainText — plain
 * yjs, no BlockNote). A page with no body yet is indexed by title alone.
 */
export async function processReindexTask(tx: Tx, task: { organizationId: string; entityType: RagEntityType; entityId: string; action: "index" | "delete" }) {
  if (task.action === "delete") {
    await tx.delete(schema.embedding).where(and(eq(schema.embedding.entityType, task.entityType), eq(schema.embedding.entityId, task.entityId)));
    return;
  }

  if (task.entityType === "issue") {
    const [issue] = await tx.select().from(schema.issue).where(eq(schema.issue.id, task.entityId));
    if (!issue) return; // deleted since being queued

    const parts = [issue.title, toPlainText(issue.descriptionJson)];
    await indexEntity(tx, { organizationId: task.organizationId, entityType: "issue", entityId: task.entityId, text: parts.filter(Boolean).join("\n\n") });
  } else if (task.entityType === "comment") {
    const [comment] = await tx.select().from(schema.issueComment).where(eq(schema.issueComment.id, task.entityId));
    if (!comment) return;
    const text = toPlainText(comment.bodyJson);
    await indexEntity(tx, { organizationId: task.organizationId, entityType: "comment", entityId: task.entityId, text });
  } else if (task.entityType === "page") {
    const [page] = await tx.select().from(schema.page).where(eq(schema.page.id, task.entityId));
    if (!page) return; // deleted since being queued
    const [state] = await tx.select().from(schema.ydocState).where(eq(schema.ydocState.pageId, task.entityId));
    const text = [page.title, state ? pageStateToPlainText(state.state) : ""].filter(Boolean).join("\n\n");
    await indexEntity(tx, { organizationId: task.organizationId, entityType: "page", entityId: task.entityId, text });
  }
}

/**
 * Queues an index task for every issue, comment and page in one workspace —
 * the "Re-index everything" admin action, for after an embedding model change
 * (a fixed-dimension column means old vectors aren't comparable) or an
 * initial backfill. Pass the admin connection: a workspace admin's own RLS may
 * not see every team's content, and the queue is system-wide anyway.
 *
 * One INSERT ... SELECT per entity type, with the same pending-task guard as
 * enqueueReindex, so it scales to large workspaces and a re-run doesn't
 * double-queue work that's already pending. Returns how many tasks were
 * actually inserted per type.
 */
export async function enqueueFullReindex(db: AnyDb, organizationId: string): Promise<{ issues: number; comments: number; pages: number }> {
  const insertFor = async (entityType: RagEntityType, idRows: SQL) => {
    const inserted = await db.execute<{ id: string }>(
      sql`insert into embedding_index_queue (id, organization_id, entity_type, entity_id, action)
          select 'ridx_' || replace(gen_random_uuid()::text, '-', ''), ${organizationId}, ${entityType}, src.id, 'index'
          from (${idRows}) as src(id)
          where not exists (
            select 1 from embedding_index_queue q
            where q.entity_type = ${entityType} and q.entity_id = src.id and q.action = 'index' and q.status = 'pending'
          )
          returning id`,
    );
    return inserted.length;
  };

  const issues = await insertFor("issue", sql`select i.id from issue i where i.organization_id = ${organizationId}`);
  const comments = await insertFor(
    "comment",
    sql`select c.id from issue_comment c join issue i on i.id = c.issue_id where i.organization_id = ${organizationId}`,
  );
  const pages = await insertFor("page", sql`select p.id from page p where p.organization_id = ${organizationId}`);
  return { issues, comments, pages };
}

/** The Test connection form for embeddings: the same fields Save takes, minus the ones a test doesn't use. */
export type EmbeddingTestOverrides = Omit<UpdateEmbeddingSettingsInput, "featuresEnabled" | "updatedBy">;

/**
 * Test connection for the deployment embedding config. Embeds one short string
 * and checks the vector length against the column size (see testEmbeddingConnection).
 * Overrides and the key rules match testAiProvider in ai.ts: blank fields mean
 * null, a blank key keeps the stored one, and a stored key is never sent to a
 * new endpoint. Never throws; the API key is masked in any message.
 */
export async function testEmbeddingProvider(db: AnyDb, overrides?: EmbeddingTestOverrides): Promise<EmbeddingTestResult> {
  let creds: EmbeddingCredentials;
  try {
    const row = await getSystemSettingsRow(db);
    const stored = row?.embeddingProvider ? embeddingCredentialsFromRow(row) : null;

    if (!overrides) {
      if (!stored?.apiKey) return { ok: false, message: new EmbeddingNotConfiguredError().message };
      creds = stored;
    } else {
      assertKeyNotRetargeted(
        Boolean(row?.embeddingApiKeyEncrypted),
        overrides.apiKey,
        { provider: row?.embeddingProvider, azureEndpoint: row?.embeddingAzureEndpoint, openAiCompatibleBaseUrl: row?.embeddingOpenAiCompatibleBaseUrl },
        { provider: overrides.provider, azureEndpoint: overrides.azureEndpoint, openAiCompatibleBaseUrl: overrides.openAiCompatibleBaseUrl },
      );
      creds = {
        provider: overrides.provider,
        apiKey: overrides.apiKey || stored?.apiKey || null,
        model: overrides.model || null,
        azureEndpoint: overrides.azureEndpoint || null,
        azureDeployment: overrides.azureDeployment || null,
        openAiCompatibleBaseUrl: overrides.openAiCompatibleBaseUrl || null,
      };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const result = await testEmbeddingConnection(creds, schema.EMBEDDING_DIMENSIONS);
  return result.ok ? result : { ...result, message: redactSecret(result.message, creds.apiKey) };
}

/** Longest failure message the status panel receives. Provider bodies can be long; the table truncates further. */
const STATUS_ERROR_MAX_CHARS = 500;

export interface EmbeddingStatus {
  /** Embeddings are switched on and have a key. When false, the panel shows its empty state. */
  configured: boolean;
  /** Distinct indexed entities per type, against every such entity in the workspace. */
  indexed: Record<RagEntityType, { indexed: number; total: number }>;
  queue: {
    pending: number;
    processing: number;
    failed: number;
    /** Age of the oldest pending task in seconds (null when nothing is pending). */
    oldestPendingAgeSeconds: number | null;
    /** Pending tasks that failed at least one attempt and are waiting out their retry backoff (or are about to be retried). */
    waitingRetry: number;
    /** How long the oldest claimable pending task has been claimable, in seconds (null when none is). */
    oldestReadyAgeSeconds: number | null;
    /** Seconds since a worker last claimed any of this workspace's tasks (null when none ever was). */
    lastClaimAgeSeconds: number | null;
    /** Ready tasks have waited longer than REINDEX_STALL_SECONDS and nothing was claimed in that time — the worker is likely not running. */
    workerStalled: boolean;
    /** MAX_REINDEX_ATTEMPTS, for the panel's explanation of when a retrying task gives up. */
    maxAttempts: number;
  };
  /** The 10 pending tasks with a failed attempt, soonest retry first, with their last error. */
  recentRetries: { id: string; entityType: RagEntityType; entityId: string; attempts: number; error: string | null; nextAttemptInSeconds: number }[];
  /** The 10 most recent failed tasks, newest first. */
  recentFailures: { id: string; entityType: RagEntityType; entityId: string; attempts: number; error: string | null; claimedAt: Date | null }[];
}

/**
 * Indexing progress for the Settings → Embedding panel. Runs on the admin
 * connection for the same reason as enqueueFullReindex: the counts are
 * workspace-wide, and a workspace admin's own RLS may not show every team's
 * content. Every query is filtered on organization_id, so one workspace's
 * queue never shows up in another's status.
 */
export async function getEmbeddingStatus(db: AnyDb, organizationId: string): Promise<EmbeddingStatus> {
  const settings = await getSystemSettingsRow(db);
  const configured = Boolean(settings?.embeddingProvider && settings.embeddingApiKeyEncrypted && settings.embeddingFeaturesEnabled);

  const [indexedRows, issueTotal, commentTotal, pageTotal, statusRows, oldestRows, failureRows, workerRows, retryRows] = await Promise.all([
    db
      .select({ entityType: schema.embedding.entityType, n: countDistinct(schema.embedding.entityId) })
      .from(schema.embedding)
      .where(eq(schema.embedding.organizationId, organizationId))
      .groupBy(schema.embedding.entityType),
    db.select({ n: count() }).from(schema.issue).where(eq(schema.issue.organizationId, organizationId)),
    db
      .select({ n: count() })
      .from(schema.issueComment)
      .innerJoin(schema.issue, eq(schema.issue.id, schema.issueComment.issueId))
      .where(eq(schema.issue.organizationId, organizationId)),
    db.select({ n: count() }).from(schema.page).where(eq(schema.page.organizationId, organizationId)),
    db
      .select({ status: schema.embeddingIndexQueue.status, n: count() })
      .from(schema.embeddingIndexQueue)
      .where(eq(schema.embeddingIndexQueue.organizationId, organizationId))
      .groupBy(schema.embeddingIndexQueue.status),
    // Age is computed in SQL so there's no timestamp parsing in JS. min() over zero rows is null, so the age is null too.
    db
      .select({ ageSeconds: sql<string | null>`extract(epoch from (now() - min(${schema.embeddingIndexQueue.createdAt})))` })
      .from(schema.embeddingIndexQueue)
      .where(and(eq(schema.embeddingIndexQueue.organizationId, organizationId), eq(schema.embeddingIndexQueue.status, "pending"))),
    db
      .select({
        id: schema.embeddingIndexQueue.id,
        entityType: schema.embeddingIndexQueue.entityType,
        entityId: schema.embeddingIndexQueue.entityId,
        attempts: schema.embeddingIndexQueue.attempts,
        error: schema.embeddingIndexQueue.error,
        claimedAt: schema.embeddingIndexQueue.claimedAt,
      })
      .from(schema.embeddingIndexQueue)
      .where(and(eq(schema.embeddingIndexQueue.organizationId, organizationId), eq(schema.embeddingIndexQueue.status, "failed")))
      .orderBy(desc(sql`coalesce(${schema.embeddingIndexQueue.claimedAt}, ${schema.embeddingIndexQueue.createdAt})`), desc(schema.embeddingIndexQueue.id))
      .limit(10),
    // Ready-since is created_at for a task that never failed, else the end of its backoff. Ages are computed in SQL (no JS timestamp parsing).
    db.execute<{ waiting_retry: string; oldest_ready_age: string | null; last_claim_age: string | null }>(
      sql`select
            (select count(*) from embedding_index_queue
              where organization_id = ${organizationId} and status = 'pending' and attempts > 0) as waiting_retry,
            (select extract(epoch from (now() - min(case when attempts = 0 or claimed_at is null then created_at else ${REINDEX_RETRY_AT} end)))
              from embedding_index_queue
              where organization_id = ${organizationId} and status = 'pending' and ${REINDEX_READY}) as oldest_ready_age,
            (select extract(epoch from (now() - max(claimed_at)))
              from embedding_index_queue where organization_id = ${organizationId}) as last_claim_age`,
    ),
    db.execute<{ id: string; entity_type: RagEntityType; entity_id: string; attempts: number; error: string | null; next_in: string | null }>(
      sql`select id, entity_type, entity_id, attempts, error,
                 extract(epoch from (${REINDEX_RETRY_AT} - now())) as next_in
          from embedding_index_queue
          where organization_id = ${organizationId} and status = 'pending' and attempts > 0
          order by ${REINDEX_RETRY_AT} asc nulls first, id
          limit 10`,
    ),
  ]);

  const seconds = (v: string | null | undefined) => (v == null ? null : Math.max(0, Math.round(Number(v))));
  const worker = workerRows[0];
  const oldestReadyAgeSeconds = seconds(worker?.oldest_ready_age);
  const lastClaimAgeSeconds = seconds(worker?.last_claim_age);
  const workerStalled =
    oldestReadyAgeSeconds !== null && oldestReadyAgeSeconds > REINDEX_STALL_SECONDS && (lastClaimAgeSeconds === null || lastClaimAgeSeconds > REINDEX_STALL_SECONDS);

  const indexedCount = (entityType: RagEntityType) => indexedRows.find((r) => r.entityType === entityType)?.n ?? 0;
  const statusCount = (status: string) => statusRows.find((r) => r.status === status)?.n ?? 0;
  const oldest = oldestRows[0]?.ageSeconds;

  return {
    configured,
    indexed: {
      issue: { indexed: indexedCount("issue"), total: issueTotal[0]?.n ?? 0 },
      comment: { indexed: indexedCount("comment"), total: commentTotal[0]?.n ?? 0 },
      page: { indexed: indexedCount("page"), total: pageTotal[0]?.n ?? 0 },
    },
    queue: {
      pending: statusCount("pending"),
      processing: statusCount("processing"),
      failed: statusCount("failed"),
      oldestPendingAgeSeconds: oldest == null ? null : Math.max(0, Math.round(Number(oldest))),
      waitingRetry: Number(worker?.waiting_retry ?? 0),
      oldestReadyAgeSeconds,
      lastClaimAgeSeconds,
      workerStalled,
      maxAttempts: MAX_REINDEX_ATTEMPTS,
    },
    recentRetries: retryRows.map((r) => ({
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      attempts: Number(r.attempts),
      error: r.error == null ? null : r.error.slice(0, STATUS_ERROR_MAX_CHARS),
      nextAttemptInSeconds: seconds(r.next_in) ?? 0,
    })),
    recentFailures: failureRows.map((r) => ({
      ...r,
      entityType: r.entityType as RagEntityType,
      error: r.error == null ? null : r.error.slice(0, STATUS_ERROR_MAX_CHARS),
    })),
  };
}

/**
 * Puts this workspace's failed reindex tasks back in the queue: status pending,
 * attempts 0, error cleared. Only "failed" rows of this organization are touched,
 * so pending, processing and processed work, and other workspaces, are unaffected.
 * Returns how many tasks were reset.
 */
export async function retryFailedReindexTasks(db: AnyDb, organizationId: string): Promise<number> {
  const rows = await db
    .update(schema.embeddingIndexQueue)
    .set({ status: "pending", attempts: 0, error: null })
    .where(and(eq(schema.embeddingIndexQueue.organizationId, organizationId), eq(schema.embeddingIndexQueue.status, "failed")))
    .returning({ id: schema.embeddingIndexQueue.id });
  return rows.length;
}

/**
 * Ends the retry backoff of this workspace's pending tasks that failed an attempt, so the
 * worker picks them up on its next poll. claimed_at is moved back by exactly the backoff
 * rather than cleared, so the task becomes ready "now" (not at its created_at, which would
 * read as a stalled worker) and keeps its attempt count — a task that keeps failing still
 * ends up "failed" after MAX_REINDEX_ATTEMPTS. Returns how many tasks were moved up.
 */
export async function retryWaitingReindexTasksNow(db: AnyDb, organizationId: string): Promise<number> {
  const rows = await db.execute<{ id: string }>(
    sql`update embedding_index_queue
        set claimed_at = now() - make_interval(mins => (2 ^ least(attempts, 6))::int)
        where organization_id = ${organizationId} and status = 'pending' and attempts > 0
        returning id`,
  );
  return rows.length;
}

export interface SearchResult {
  entityType: RagEntityType;
  entityId: string;
  content: string;
  distance: number;
}

/**
 * Team/project/page visibility is enforced by the `embedding` RLS policy (packages/db/rls.sql),
 * which defers to the issue / issue_comment / page policies — so this runs as the asking user and
 * only sees chunks of entities that user can read. On top of that, this function drops archived
 * entities (an archived issue, a comment on an archived issue, an archived page), which RLS does
 * not filter on.
 */
export async function searchEmbeddings(tx: Tx, input: { organizationId: string; queryVector: number[]; entityTypes?: RagEntityType[]; limit?: number }): Promise<SearchResult[]> {
  const conditions = [
    eq(schema.embedding.organizationId, input.organizationId),
    sql`not exists (
      select 1 from issue i
      where ${schema.embedding.entityType} = 'issue' and i.id = ${schema.embedding.entityId} and i.archived_at is not null
    )`,
    sql`not exists (
      select 1 from issue_comment c join issue i on i.id = c.issue_id
      where ${schema.embedding.entityType} = 'comment' and c.id = ${schema.embedding.entityId} and i.archived_at is not null
    )`,
    sql`not exists (
      select 1 from page p
      where ${schema.embedding.entityType} = 'page' and p.id = ${schema.embedding.entityId} and p.archived_at is not null
    )`,
  ];
  if (input.entityTypes?.length) conditions.push(inArray(schema.embedding.entityType, input.entityTypes));

  const distance = cosineDistance(schema.embedding.vector, input.queryVector);
  const rows = await tx
    .select({ entityType: schema.embedding.entityType, entityId: schema.embedding.entityId, content: schema.embedding.content, distance })
    .from(schema.embedding)
    .where(and(...conditions))
    .orderBy(asc(distance))
    .limit(input.limit ?? 8);

  return rows.map((r) => ({ ...r, distance: Number(r.distance) }));
}

export async function createThread(tx: Tx, input: { organizationId: string; userId: string }) {
  const threadId = id("thread");
  await tx.insert(schema.aiThread).values({ id: threadId, organizationId: input.organizationId, userId: input.userId });
  return { threadId };
}

export async function listThreads(tx: Tx, userId: string) {
  return tx.select().from(schema.aiThread).where(eq(schema.aiThread.userId, userId)).orderBy(sql`${schema.aiThread.updatedAt} desc`);
}

/**
 * Renames one of the caller's own threads. Does not touch `updatedAt`, so a rename never reorders the list.
 * RLS already limits `ai_thread` to its owner; the explicit userId filter is belt-and-braces.
 */
export async function renameThread(tx: Tx, userId: string, input: { threadId: string; title: string }) {
  const title = input.title.trim();
  if (!title) throw new UserFacingError("Conversation title can't be empty");
  const rows = await tx
    .update(schema.aiThread)
    .set({ title: title.slice(0, 200) })
    .where(and(eq(schema.aiThread.id, input.threadId), eq(schema.aiThread.userId, userId)))
    .returning({ id: schema.aiThread.id });
  if (rows.length === 0) throw new NotFoundError("Conversation not found");
  return { threadId: input.threadId };
}

/** Deletes one of the caller's own threads. Its ai_message rows cascade. */
export async function deleteThread(tx: Tx, userId: string, threadId: string) {
  const rows = await tx
    .delete(schema.aiThread)
    .where(and(eq(schema.aiThread.id, threadId), eq(schema.aiThread.userId, userId)))
    .returning({ id: schema.aiThread.id });
  if (rows.length === 0) throw new NotFoundError("Conversation not found");
  return { threadId };
}

export async function listMessages(tx: Tx, threadId: string) {
  return tx.select().from(schema.aiMessage).where(eq(schema.aiMessage.threadId, threadId)).orderBy(asc(schema.aiMessage.createdAt));
}

export class EmbeddingNotConfiguredError extends Error {
  constructor() {
    super("Embeddings are not configured or not enabled for this workspace — set them up in /settings");
    this.name = "EmbeddingNotConfiguredError";
  }
}

export class AskThreadNotFoundError extends Error {
  constructor() {
    super("Conversation not found");
    this.name = "AskThreadNotFoundError";
  }
}

export interface AskKompastInput {
  /** Omit to start a new thread. */
  threadId?: string;
  question: string;
  onDelta?: (delta: string) => void;
  /** Called with the tool name just before each lookup runs, so the UI can show what the model is checking. */
  onTool?: (name: string) => void;
  /** Called with each change the model drafted (a proposal awaiting the user's Apply). Persisted only if the answer completes. */
  onProposal?: (proposal: AskProposal) => void;
}

export interface Citation {
  entityType: RagEntityType;
  entityId: string;
  excerpt: string;
  /** "KMP-42 · Login fails" for an issue or comment, the page title for a page. Absent on citations stored before this field existed. */
  title?: string;
  /** What the UI links to. Absent on citations stored before this field existed. */
  ref?: { kind: "issue"; teamId: string | null; projectKey: string; keySeq: number } | { kind: "page"; pageId: string };
}

const SYSTEM_PROMPT =
  "You are Ask Kompast, a workspace assistant with access to a retrieved excerpt of this workspace's issues, comments, docs/pages, and (where noted) sprint context. " +
  "Answer using ONLY the context provided below — if the context doesn't cover the question, say so plainly rather than guessing. " +
  "Each context entry starts with a header line. For issues and comments, the header carries the issue's CURRENT status, assignee and sprint, read live from the tracker — they can differ from what the excerpt text says, so trust the header. " +
  "Be concise. When you reference a specific issue, cite it by its key (for example KMP-42) so the user can find it. " +
  "You also have tools that read the live tracker: list_projects, list_issues, get_issue, get_sprint and search_workspace. " +
  "Prefer them for questions about status, assignee, sprint, 'list all' or counts, because the excerpts above are only a sample. " +
  "Only state facts that a tool or the excerpts actually returned, never claim to see data you did not get back, and if a tool returns an error say what could not be checked. " +
  "You can also draft changes with create_issue, add_comment and create_page. These only create a proposal card the user must approve; nothing changes until they click Apply. " +
  "Never say something was created, commented or saved — say you drafted it for their approval. If a required detail like the project is unclear, ask instead of guessing. Only draft a change when the user asks for one.";

/** Prior assistant text, plus one line per drafted change so a follow-up knows what was proposed and whether it was applied. */
function historyContent(m: { role: "user" | "assistant"; content: string; proposals?: unknown }): string {
  if (m.role !== "assistant" || !Array.isArray(m.proposals) || m.proposals.length === 0) return m.content;
  const lines = (m.proposals as AskProposal[]).map(
    (p) => `[Drafted ${p.kind} "${p.preview.title}" — ${p.status}${p.result?.issueKey ? ` as ${p.result.issueKey}` : ""}]`,
  );
  return [m.content, ...lines].filter(Boolean).join("\n");
}

function issueFactsLine(f: { statusName: string | null; typeName: string | null; priorityName: string | null; assigneeName: string | null; sprint: { name: string; state: string } | null; labels: string[] }): string {
  return [
    f.statusName,
    f.typeName,
    f.priorityName,
    f.assigneeName ? `assignee: ${f.assigneeName}` : null,
    f.sprint ? `sprint: ${f.sprint.name} (${f.sprint.state})` : null,
    f.labels.length ? `labels: ${f.labels.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The one-line header above each context entry, e.g. `Issue KMP-42 "Login fails" · In Progress · Bug · High · assignee: Alice`. */
export function contextHeader(e: RagEnrichment): string {
  if (e.kind === "page") return `Doc "${e.title || "Untitled"}" (${e.space})`;
  const head = e.kind === "issue" ? `Issue ${e.issue.key} "${e.issue.title}"` : `Comment on ${e.issue.key} "${e.issue.title}"`;
  const facts = issueFactsLine(e.issue);
  return facts ? `${head} · ${facts}` : head;
}

function citationTitle(e: RagEnrichment): string {
  return e.kind === "page" ? e.title : `${e.issue.key} · ${e.issue.title}`;
}

function citationRef(e: RagEnrichment, candidateId: string): NonNullable<Citation["ref"]> {
  if (e.kind === "page") return { kind: "page", pageId: candidateId };
  return { kind: "issue", teamId: e.issue.teamId, projectKey: e.issue.projectKey, keySeq: e.issue.keySeq };
}

/**
 * Pure assembly of the chat messages and the citations, from already-enriched
 * candidates. Citation i and context entry [i+1] are the same item, so the
 * model's numbering maps straight onto the citations the UI shows.
 */
function buildAskMessages(input: { history: { role: "user" | "assistant"; content: string; proposals?: unknown }[]; enriched: EnrichedCandidate[]; question: string }) {
  const citations: Citation[] = input.enriched.map(({ candidate, enrichment }) => ({
    entityType: candidate.entityType,
    entityId: candidate.entityId,
    excerpt: candidate.content.slice(0, 240),
    title: citationTitle(enrichment),
    ref: citationRef(enrichment, candidate.entityId),
  }));
  const contextBlock =
    input.enriched.length > 0
      ? input.enriched.map(({ candidate, enrichment }, i) => `[${i + 1}] ${contextHeader(enrichment)}\n${candidate.content}`).join("\n\n")
      : "(no relevant context found)";

  const messages: AiMessage[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\nContext:\n${contextBlock}` },
    ...input.history.map((m) => ({ role: m.role, content: historyContent(m) }) as AiMessage),
    { role: "user", content: input.question },
  ];
  return { messages, citations };
}

/** Upper bound on model turns for one question. The last turn is sent without tools, so the model has to answer from what it already has. */
export const MAX_ASK_TURNS = 5;

/** One streamed model turn. `tools` is omitted on the final turn so the model cannot ask for more lookups. */
async function completeModelTurn(creds: AiCredentials, messages: AiMessage[], onDelta?: (delta: string) => void, tools?: AiToolDefinition[]) {
  const client = createAiClient(creds);
  return client.streamCompletion({ messages, tools }, onDelta ?? (() => {}));
}

/**
 * The tool-use loop. Each turn streams the model's answer; if it stops to ask
 * for lookups, every requested tool runs as the asking user (runAskTool, each
 * on its own short transaction, never inside one) and the results go back as
 * `tool` messages for the next turn. Token counts are summed across turns so
 * the caller can record one ai_usage row for the whole question. Only the
 * final turn's text is returned; text streamed in earlier turns still reaches
 * onDelta, but isn't persisted.
 */
async function runAskTurns(
  ctx: AuthContext,
  creds: AiCredentials,
  messages: AiMessage[],
  opts: { onDelta?: (delta: string) => void; onTool?: (name: string) => void; onProposal?: (proposal: AskProposal) => void },
): Promise<{ text: string; inputTokens: number; outputTokens: number; proposals: AskProposal[] }> {
  const transcript: AiMessage[] = [...messages];
  const proposals: AskProposal[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let turnNo = 1; ; turnNo++) {
    const isLastTurn = turnNo >= MAX_ASK_TURNS;
    const result = await completeModelTurn(creds, transcript, opts.onDelta, isLastTurn ? undefined : askTools);
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;

    if (isLastTurn || result.stopReason !== "tool_use" || result.toolCalls.length === 0) {
      return { text: result.text, inputTokens, outputTokens, proposals };
    }

    transcript.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      opts.onTool?.(call.name);
      if (ASK_WRITE_TOOL_NAMES.has(call.name)) {
        // A write tool only drafts; the change runs when the user clicks Apply (applyAskProposal).
        const { output, proposal } = await proposeAskWrite(ctx, call);
        if (proposal) {
          proposals.push(proposal);
          opts.onProposal?.(proposal);
        }
        transcript.push({ role: "tool", toolCallId: call.id, content: output });
      } else {
        transcript.push({ role: "tool", toolCallId: call.id, content: await runAskTool(ctx, call) });
      }
    }
  }
}

/**
 * The retrieval half of Ask Kompast, reusable by the search_workspace tool:
 * embeds the question, runs the vector search, and drops candidates whose
 * entity isn't visible to the caller (enrichCandidates). Runs on the caller's
 * transaction, so RLS decides what can be retrieved.
 */
export async function retrieveContext(
  tx: Tx,
  input: { userId: string; organizationId: string; embeddingCreds: EmbeddingCredentials; question: string; limit?: number },
): Promise<EnrichedCandidate[]> {
  const [queryVector] = await createEmbeddingClient(input.embeddingCreds, { dimensions: schema.EMBEDDING_DIMENSIONS }).embed([input.question]);
  const candidates = await searchEmbeddings(tx, { organizationId: input.organizationId, queryVector: queryVector!, limit: input.limit ?? 8 });
  return enrichCandidates(tx, candidates, { userId: input.userId, organizationId: input.organizationId });
}

/**
 * Ask Kompast as three steps, so no database transaction is open while the
 * model streams (which can take many seconds):
 *
 *   1. Read transaction, as the asking user (RLS applies): credentials, thread
 *      ownership, prior history, embed the question, vector search, live
 *      enrichment, build the messages. The question embedding is one short HTTP
 *      call made inside this transaction: the search needs its vector, and the
 *      whole read stays under one RLS identity. Nothing is written here.
 *   2. No transaction across the model turns: each streamed model call runs
 *      alone, and each tool lookup the model asks for runs in its own short
 *      read transaction (runAskTool). If anything fails, nothing has been
 *      persisted, so a failed ask leaves no thread and no message behind.
 *   3. Write transaction: create the thread if it is new, insert the question
 *      and the answer (with citations), record ai_usage.
 *
 * A brand new thread's title is derived from the first question, not asked upfront.
 */
export async function askKompast(
  ctx: AuthContext,
  input: AskKompastInput,
): Promise<{ threadId: string; messageId: string; answer: string; citations: Citation[]; proposals: AskProposal[] }> {
  const isNewThread = !input.threadId;
  const threadId = input.threadId ?? id("thread");

  const turn = await withAuthorizedTenant(ctx, async (tx) => {
    const embeddingCreds = await getEmbeddingCredentials(tx);
    if (!embeddingCreds) throw new EmbeddingNotConfiguredError();
    const aiCreds = await getAiCredentials(tx);
    if (!aiCreds) throw new AiNotConfiguredError();

    if (input.threadId) {
      // RLS hides other users' threads, so "not found" also covers "not yours".
      const [owned] = await tx.select({ id: schema.aiThread.id }).from(schema.aiThread).where(eq(schema.aiThread.id, input.threadId));
      if (!owned) throw new AskThreadNotFoundError();
    }
    const history = isNewThread ? [] : await listMessages(tx, threadId);

    const enriched = await retrieveContext(tx, { userId: ctx.userId, organizationId: ctx.organizationId, embeddingCreds, question: input.question, limit: 8 });

    return { aiCreds, ...buildAskMessages({ history, enriched, question: input.question }) };
  });

  const answer = await runAskTurns(ctx, turn.aiCreds, turn.messages, { onDelta: input.onDelta, onTool: input.onTool, onProposal: input.onProposal });
  const assistantMessageId = id("msg");

  await withAuthorizedTenant(ctx, async (tx) => {
    if (isNewThread) {
      await tx.insert(schema.aiThread).values({ id: threadId, organizationId: ctx.organizationId, userId: ctx.userId, title: input.question.slice(0, 80) });
    }
    // Explicit, strictly increasing timestamps: both rows are written in one
    // transaction, where the column default now() is identical for both, and
    // listMessages orders by createdAt — a tie could replay history out of order.
    const askedAt = new Date();
    const answeredAt = new Date(askedAt.getTime() + 1);
    await tx.insert(schema.aiMessage).values({ id: id("msg"), threadId, role: "user", content: input.question, createdAt: askedAt });
    await tx.insert(schema.aiMessage).values({
      id: assistantMessageId,
      threadId,
      role: "assistant",
      content: answer.text,
      citations: turn.citations as unknown as Json,
      proposals: answer.proposals.length ? (answer.proposals as unknown as Json) : null,
      createdAt: answeredAt,
    });
    await recordAiUsage(tx, {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      feature: "ask-kompast",
      provider: turn.aiCreds.provider,
      model: resolveModelName(turn.aiCreds),
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
    });
    await tx.update(schema.aiThread).set({ updatedAt: new Date() }).where(eq(schema.aiThread.id, threadId));
  });

  return { threadId, messageId: assistantMessageId, answer: answer.text, citations: turn.citations, proposals: answer.proposals };
}
