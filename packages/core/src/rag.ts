import { and, asc, eq, inArray, sql, cosineDistance, schema, type Json, type SQL } from "@kompast/db";
import { createAiClient, createEmbeddingClient, resolveModelName, type AiCredentials, type AiMessage, type AiToolDefinition, type EmbeddingCredentials } from "@kompast/ai";
import type { Tx, AnyDb } from "./types";
import { id } from "./ids";
import { withAuthorizedTenant, type AuthContext } from "./permissions";
import { getAiCredentials, getEmbeddingCredentials } from "./settings";
import { AiNotConfiguredError, recordAiUsage } from "./ai";
import { enrichCandidates, type EnrichedCandidate, type RagEnrichment } from "./rag-enrich";
import { askTools, runAskTool } from "./ask-tools";
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

  const client = createEmbeddingClient(creds);
  const vectors = await client.embed(chunks);

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
 * System-wide scan across every workspace's queue — same admin-connection exception as claimPendingEmails/claimPendingAutomationEvents (see rls.sql).
 * Also reclaims tasks whose "processing" claim went stale, and honours retry backoff after a failed attempt.
 */
export async function claimPendingReindexTasks(db: AnyDb, limit = 10) {
  const claimed = await db.execute<{ id: string }>(
    sql`update embedding_index_queue set status = 'processing', claimed_at = now()
        where id in (
          select id from embedding_index_queue
          where (status = 'pending'
                 and (attempts = 0 or claimed_at is null
                      or claimed_at <= now() - make_interval(mins => (2 ^ least(attempts, 6))::int)))
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
  "Only state facts that a tool or the excerpts actually returned, never claim to see data you did not get back, and if a tool returns an error say what could not be checked.";

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
function buildAskMessages(input: { history: { role: "user" | "assistant"; content: string }[]; enriched: EnrichedCandidate[]; question: string }) {
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
    ...input.history.map((m) => ({ role: m.role, content: m.content }) as AiMessage),
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
  opts: { onDelta?: (delta: string) => void; onTool?: (name: string) => void },
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const transcript: AiMessage[] = [...messages];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let turnNo = 1; ; turnNo++) {
    const isLastTurn = turnNo >= MAX_ASK_TURNS;
    const result = await completeModelTurn(creds, transcript, opts.onDelta, isLastTurn ? undefined : askTools);
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;

    if (isLastTurn || result.stopReason !== "tool_use" || result.toolCalls.length === 0) {
      return { text: result.text, inputTokens, outputTokens };
    }

    transcript.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      opts.onTool?.(call.name);
      transcript.push({ role: "tool", toolCallId: call.id, content: await runAskTool(ctx, call) });
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
  const [queryVector] = await createEmbeddingClient(input.embeddingCreds).embed([input.question]);
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
export async function askKompast(ctx: AuthContext, input: AskKompastInput): Promise<{ threadId: string; answer: string; citations: Citation[] }> {
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

  const answer = await runAskTurns(ctx, turn.aiCreds, turn.messages, { onDelta: input.onDelta, onTool: input.onTool });

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
    await tx.insert(schema.aiMessage).values({ id: id("msg"), threadId, role: "assistant", content: answer.text, citations: turn.citations as unknown as Json, createdAt: answeredAt });
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

  return { threadId, answer: answer.text, citations: turn.citations };
}
