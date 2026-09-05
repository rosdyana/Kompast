import { and, asc, eq, inArray, sql, cosineDistance, schema, type Json } from "@kompast/db";
import { createEmbeddingClient, type AiMessage } from "@kompast/ai";
import type { Tx, AnyDb } from "./types";
import { id } from "./ids";
import { getEmbeddingCredentials } from "./settings";
import { runAiCompletion } from "./ai";

export type RagEntityType = "issue" | "comment" | "page";

const MAX_CHUNK_CHARS = 1000;

/**
 * Paragraph-aware, not sentence-aware — splits on blank lines and greedily
 * merges paragraphs up to MAX_CHUNK_CHARS. A single paragraph longer than
 * that is kept whole rather than cut mid-sentence (a slightly-oversized
 * chunk beats a chunk that stops mid-thought). Good enough for issue/
 * comment text; may need revisiting once page content (much longer,
 * richer structure) is indexed in stage B.
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

export interface EnqueueReindexInput {
  organizationId: string;
  entityType: RagEntityType;
  entityId: string;
  action?: "index" | "delete";
}

/** Transactional outbox for (re)indexing — same pattern as enqueueEmail/emitAutomationEvent. Call in the SAME transaction as the mutation that changed indexable content. */
export async function enqueueReindex(tx: Tx, input: EnqueueReindexInput) {
  await tx.insert(schema.embeddingIndexQueue).values({
    id: id("ridx"),
    organizationId: input.organizationId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action ?? "index",
  });
}

/** System-wide scan across every workspace's queue — same admin-connection exception as claimPendingEmails/claimPendingAutomationEvents (see rls.sql). */
export async function claimPendingReindexTasks(db: AnyDb, limit = 10) {
  const claimed = await db.execute<{ id: string }>(
    sql`update embedding_index_queue set status = 'processing'
        where id in (
          select id from embedding_index_queue where status = 'pending' order by created_at limit ${limit} for update skip locked
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
 * Fetches CURRENT content fresh (never from the queue payload — avoids
 * embedding stale text if several edits land before this task is
 * processed) and dispatches to indexEntity. "page" is stage B — not
 * implemented yet, so a queued page task is a silent no-op rather than
 * an error (nothing enqueues page tasks yet either).
 */
export async function processReindexTask(tx: Tx, task: { organizationId: string; entityType: RagEntityType; entityId: string; action: "index" | "delete" }) {
  if (task.action === "delete") {
    await tx.delete(schema.embedding).where(and(eq(schema.embedding.entityType, task.entityType), eq(schema.embedding.entityId, task.entityId)));
    return;
  }

  if (task.entityType === "issue") {
    const [issue] = await tx.select().from(schema.issue).where(eq(schema.issue.id, task.entityId));
    if (!issue) return; // deleted since being queued

    const parts = [issue.title, (issue.descriptionJson as { text?: string } | null)?.text ?? ""];
    if (issue.sprintId) {
      const [sprint] = await tx.select({ name: schema.sprint.name, goal: schema.sprint.goal }).from(schema.sprint).where(eq(schema.sprint.id, issue.sprintId));
      // Folded into the issue's own indexed text (not a separately-indexed entity) — lets a query like
      // "what were we shipping in the Q3 auth sprint" surface issues via their own embeddings.
      if (sprint) parts.push(`Sprint: ${sprint.name}${sprint.goal ? ` — ${sprint.goal}` : ""}`);
    }
    await indexEntity(tx, { organizationId: task.organizationId, entityType: "issue", entityId: task.entityId, text: parts.filter(Boolean).join("\n\n") });
  } else if (task.entityType === "comment") {
    const [comment] = await tx.select().from(schema.issueComment).where(eq(schema.issueComment.id, task.entityId));
    if (!comment) return;
    const text = (comment.bodyJson as { text?: string } | null)?.text ?? "";
    await indexEntity(tx, { organizationId: task.organizationId, entityType: "comment", entityId: task.entityId, text });
  }
}

export interface SearchResult {
  entityType: RagEntityType;
  entityId: string;
  content: string;
  distance: number;
}

/** Org-scoped only (RLS via withAuthorizedTenant already enforces this) — issues/comments have no additional per-row permission layer the way pages will in stage B, so no extra filtering needed here yet. */
export async function searchEmbeddings(tx: Tx, input: { organizationId: string; queryVector: number[]; entityTypes?: RagEntityType[]; limit?: number }): Promise<SearchResult[]> {
  const conditions = [eq(schema.embedding.organizationId, input.organizationId)];
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

export interface AskKompastInput {
  organizationId: string;
  userId: string;
  /** Omit to start a new thread. */
  threadId?: string;
  question: string;
  onDelta?: (delta: string) => void;
}

export interface Citation {
  entityType: RagEntityType;
  entityId: string;
  excerpt: string;
}

const SYSTEM_PROMPT =
  "You are Ask Kompast, a workspace assistant with access to a retrieved excerpt of this workspace's issues, comments, and (where noted) sprint context. " +
  "Answer using ONLY the context provided below — if the context doesn't cover the question, say so plainly rather than guessing. " +
  "Be concise. When you reference a specific issue, mention it by name so the user can find it.";

/**
 * Retrieval (embed the question, vector search, fold in prior thread
 * history) + generation (runAiCompletion — the workspace's chat AI
 * provider, independent of the embedding provider) + persistence (both
 * the question and the answer are saved as ai_message rows). A brand new
 * thread's title is derived from the first question, not asked upfront.
 */
export async function askKompast(tx: Tx, input: AskKompastInput): Promise<{ threadId: string; answer: string; citations: Citation[] }> {
  const embeddingCreds = await getEmbeddingCredentials(tx);
  if (!embeddingCreds) throw new EmbeddingNotConfiguredError();

  let threadId = input.threadId;
  let isNewThread = false;
  if (!threadId) {
    ({ threadId } = await createThread(tx, { organizationId: input.organizationId, userId: input.userId }));
    isNewThread = true;
  }

  const embeddingClient = createEmbeddingClient(embeddingCreds);
  const [queryVector] = await embeddingClient.embed([input.question]);

  const candidates = await searchEmbeddings(tx, { organizationId: input.organizationId, queryVector: queryVector!, limit: 8 });
  const citations: Citation[] = candidates.map((c) => ({ entityType: c.entityType, entityId: c.entityId, excerpt: c.content.slice(0, 240) }));
  const contextBlock = candidates.length > 0 ? candidates.map((c, i) => `[${i + 1}] (${c.entityType} ${c.entityId})\n${c.content}`).join("\n\n") : "(no relevant context found)";

  const history = await listMessages(tx, threadId);

  const messages: AiMessage[] = [
    { role: "system", content: `${SYSTEM_PROMPT}\n\nContext:\n${contextBlock}` },
    ...history.map((m) => ({ role: m.role, content: m.content }) as AiMessage),
    { role: "user", content: input.question },
  ];

  await tx.insert(schema.aiMessage).values({ id: id("msg"), threadId, role: "user", content: input.question });

  const result = await runAiCompletion(tx, { organizationId: input.organizationId, userId: input.userId, feature: "ask-kompast", messages, onDelta: input.onDelta });

  await tx.insert(schema.aiMessage).values({ id: id("msg"), threadId, role: "assistant", content: result.text, citations: citations as unknown as Json });
  await tx
    .update(schema.aiThread)
    .set({ updatedAt: new Date(), ...(isNewThread ? { title: input.question.slice(0, 80) } : {}) })
    .where(eq(schema.aiThread.id, threadId));

  return { threadId, answer: result.text, citations };
}
