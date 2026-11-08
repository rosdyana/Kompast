import { sql, type db as Db } from "@kompast/db";
import { id } from "./ids";

/**
 * Deliberately self-contained (imports only @kompast/db and ./ids) — apps/collab
 * imports this to enqueue reindex tasks on every live doc edit, and must not pull
 * in @kompast/ai (rag.ts's embedding client) just to write one outbox row.
 *
 * Tx / AnyDb are defined here rather than imported from ./types for the same
 * reason. Keep them identical to ./types.
 */
type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
type AnyDb = typeof Db | Tx;

type RagEntityType = "issue" | "comment" | "page";

export interface EnqueueReindexInput {
  organizationId: string;
  entityType: RagEntityType;
  entityId: string;
  action?: "index" | "delete";
}

/**
 * Transactional outbox for (re)indexing — same pattern as enqueueEmail/emitAutomationEvent. Call in the SAME transaction as the mutation that changed indexable content.
 *
 * Skips the insert when a PENDING task for the same entity and action already exists —
 * a burst of edits to one issue collapses into a single task, since the worker re-reads
 * current content at process time anyway. A task already in 'processing' does NOT block
 * a new insert: that task may have read content before this edit landed, so the edit
 * needs its own pass.
 */
export async function enqueueReindex(db: AnyDb, input: EnqueueReindexInput) {
  const action = input.action ?? "index";
  await db.execute(
    sql`insert into embedding_index_queue (id, organization_id, entity_type, entity_id, action)
        select ${id("ridx")}, ${input.organizationId}, ${input.entityType}, ${input.entityId}, ${action}
        where not exists (
          select 1 from embedding_index_queue
          where entity_type = ${input.entityType} and entity_id = ${input.entityId} and action = ${action} and status = 'pending'
        )`,
  );
}
