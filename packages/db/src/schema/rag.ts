import { pgTable, text, integer, timestamp, jsonb, vector, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import type { Json } from "./_shared";

/** Only "issue"/"comment" are actually indexed so far (P7 stage A) — "page" is stage B, once docs indexing lands (needs @blocknote/server-util in apps/worker, verified separately for bundling risk — see README). */
export const ragEntityType = ["issue", "comment", "page"] as const;
export type RagEntityType = (typeof ragEntityType)[number];

/** 1536 = OpenAI/Azure's text-embedding-3-small dimension — the common default for both supported embedding providers. Fixed at the column level (pgvector requires a fixed size); changing embedding models later means a migration + full reindex, not just a settings change. */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * One row per chunk of indexed content — a long issue description or page
 * splits into several chunks, each with its own vector, so retrieval can
 * surface just the relevant paragraph rather than an entire document.
 * `content` keeps the actual chunk text so a citation can quote it without
 * a second fetch back to the source entity (which may have since changed
 * or been deleted).
 */
export const embedding = pgTable(
  "embedding",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityType: text("entity_type", { enum: ragEntityType }).notNull(),
    entityId: text("entity_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    vector: vector("vector", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("embedding_entity_chunk_uq").on(t.entityType, t.entityId, t.chunkIndex),
    index("embedding_org_idx").on(t.organizationId),
    // ANN index for cosine similarity search — plain btree indexes above
    // don't help a nearest-neighbor ORDER BY at all. HNSW over IVFFlat:
    // no separate "train on existing data" step, and this table starts
    // empty and grows continuously (no natural "build the index once"
    // moment the way a bulk-loaded IVFFlat index wants).
    index("embedding_vector_hnsw_idx").using("hnsw", t.vector.op("vector_cosine_ops")),
  ],
);

/**
 * Transactional outbox for (re)indexing — same pattern as email_outbox/
 * automation_event. A mutation that changes indexable content (issue
 * create/update, a new comment) writes a row here in the SAME transaction;
 * apps/worker's reindex queue claims pending rows and computes real
 * embeddings against current content (re-read fresh at process time, not
 * from a payload snapshot — avoids embedding stale text if several edits
 * land before the queue is processed).
 */
export const embeddingIndexQueue = pgTable(
  "embedding_index_queue",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityType: text("entity_type", { enum: ragEntityType }).notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action", { enum: ["index", "delete"] }).notNull(),
    status: text("status", { enum: ["pending", "processing", "processed", "failed"] }).notNull().default("pending"),
    error: text("error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("embedding_index_queue_status_idx").on(t.status)],
);

/** A single Ask Kompast conversation — one user's own thread, not shared across the workspace (see ai_message's RLS: scoped to the thread, which is scoped to its owning user). */
export const aiThread = pgTable(
  "ai_thread",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Null until the first exchange completes — auto-derived from the first question rather than asked upfront. */
    title: text("title"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("ai_thread_org_user_idx").on(t.organizationId, t.userId)],
);

export const aiMessage = pgTable(
  "ai_message",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => aiThread.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    /** Which retrieved chunks (entityType/entityId/content excerpt) actually fed this answer — null for a "user" role message. */
    citations: jsonb("citations").$type<Json>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ai_message_thread_idx").on(t.threadId)],
);
